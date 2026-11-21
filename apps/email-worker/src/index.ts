import { handleEmail, type WorkerEnv } from "./handler.js";

export default {
  async email(message: ForwardableEmailMessage, env: WorkerEnv): Promise<void> {
    await handleEmail(message, env);
  },
} satisfies ExportedHandler<WorkerEnv>;
