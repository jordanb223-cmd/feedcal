import { createApp } from "./app.js";

export default createApp({ version: __APP_VERSION__, commit: __GIT_SHA__ });
