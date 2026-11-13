import { promises as fs } from "node:fs";
import path from "node:path";
import { artifactApproval, command, hash, isRestrictedPath, LIMITS } from "./core.mjs";

export const SYNC_INTERVAL = 5 * 60 * 1000;
export const AUTO_POLICY = "private-workspace-outputs-v1";
const excluded = /^(?:\.git|\.copilot|node_modules|\.venv|venv|__pycache__|session-state|m-sessions|m-auth|mcp-oauth-config|\.ssh|\.aws|\.azure|\.gnupg|logs|jobs|pending|consent|\.env(?:\..*)?|.*\.(?:pem|key|pfx|p12)|config\.json|settings\.json|mcp-config\.json|permissions-config\.json|credentials(?:\..*)?|\.npmrc|\.netrc|\.gitconfig)$/i;
const MAX_ENTRIES = 20000;

export function githubRepository(remote) {
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
    if (!match) throw new Error("Working origin must identify github.com without embedded credentials.");
    return match[1];
}
export async function workingRepository(workingDirectory, run = command) {
    const { stdout: top } = await run("git", ["rev-parse", "--show-toplevel"], workingDirectory);
    const directory = path.resolve(top.trim());
    const { stdout: origin } = await run("git", ["remote", "get-url", "origin"], directory);
    const repo = githubRepository(origin);
    const { stdout } = await run("gh", ["repo", "view", repo, "--json", "nameWithOwner,visibility"], directory);
    const details = JSON.parse(stdout);
    if (details.nameWithOwner?.toLowerCase() !== repo.toLowerCase()) throw new Error("Working repository identity could not be verified.");
    return { directory, repo: details.nameWithOwner, private: details.visibility === "PRIVATE" };
}
export function inside(root, file) {
    const relative = path.relative(root, file);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
export function outputRoots(repository, workspacePath) {
    const roots = [{ kind: "workspace", directory: repository.directory }];
    if (workspacePath) {
        const directory = path.resolve(workspacePath, "files");
        roots.push({ kind: "session-files", directory });
    }
    return roots;
}
export function scopeBinding(configBinding, repository, roots) {
    return hash(JSON.stringify({ policy: AUTO_POLICY, configBinding, repo: repository.repo,
        roots: roots.map(({ kind, directory }) => ({ kind, directory: path.resolve(directory) })) }));
}
export async function scanOutputs(roots, stateRoot) {
    const files = Object.create(null), omissions = [];
    let entries = 0;
    for (const root of roots) {
        async function walk(directory) {
            let children;
            try { children = await fs.readdir(directory, { withFileTypes: true }); }
            catch (error) {
                if (error.code === "ENOENT" && directory === root.directory) return;
                throw error;
            }
            for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
                if (++entries > MAX_ENTRIES) throw new Error(`Automatic output scan exceeded ${MAX_ENTRIES} entries. No partial baseline/capture will be used.`);
                const file = path.join(directory, child.name);
                const name = `${root.kind}/${path.relative(root.directory, file).split(path.sep).join("/")}`;
                if (excluded.test(child.name) || isRestrictedPath(child.name) || file === stateRoot || inside(stateRoot, file)) continue;
                const stat = await fs.lstat(file);
                if (stat.isSymbolicLink()) { omissions.push({ artifact: name, reason: "Symlink/junction excluded from automatic outputs" }); continue; }
                if (stat.isDirectory()) { await walk(file); continue; }
                if (!stat.isFile()) continue;
                // Baselines retain only fingerprints/metadata, never a copy of unchanged source.
                let digest;
                if (stat.size <= LIMITS.file) digest = hash(await fs.readFile(file));
                files[file] = { sha256: digest, bytes: stat.size, mtime: stat.mtimeMs, name, kind: root.kind, directory: root.directory };
            }
        }
        try {
            const stat = await fs.lstat(root.directory);
            if (stat.isSymbolicLink()) throw new Error("Automatic output root cannot be a symlink/junction.");
            await walk(root.directory);
        } catch (error) {
            if (error.code === "ENOENT" && root.kind === "session-files") continue;
            throw error;
        }
    }
    return { files, omissions };
}
export async function changedOutputs(roots, baseline, stateRoot) {
    const scanned = await scanOutputs(roots, stateRoot), approvals = [], omissions = [...scanned.omissions];
    for (const [file, current] of Object.entries(scanned.files)) {
        const before = baseline[file];
        if (before && (current.sha256
            ? before.sha256 === current.sha256
            : before.bytes === current.bytes && before.mtime === current.mtime)) continue;
        try {
            const approved = await artifactApproval(file, current.kind === "session-files" ? { runtimeFilesRoot: current.directory } : {});
            approvals.push({ ...approved, automatic: true, source: current.name,
                runtimeFilesRoot: current.kind === "session-files" ? current.directory : undefined });
        } catch (error) { omissions.push({ artifact: current.name, reason: error.message }); }
    }
    return { approvals, omissions };
}
