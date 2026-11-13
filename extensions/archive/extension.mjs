import { joinSession } from "@github/copilot-sdk/extension";
import { startExtension } from "./controller.mjs";

await startExtension(joinSession);
