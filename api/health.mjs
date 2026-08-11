import { createHealthHandler } from "../server/vercel/handlers.mjs";
import { getVercelRuntime } from "../server/vercel/runtime.mjs";

export default createHealthHandler(getVercelRuntime);
