import { handleEmail } from "./handler.js";

export default {
  async email(message: ForwardableEmailMessage): Promise<void> {
    handleEmail(message);
  },
} satisfies ExportedHandler;
