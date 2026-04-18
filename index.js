import "dotenv/config";
import { startPollingService } from "./poller.js";

startPollingService().catch((err) => {
  console.error("[main] 启动失败:", err);
  process.exit(1);
});
