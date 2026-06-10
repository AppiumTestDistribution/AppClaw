import { AgentDaemon } from './daemon.js';

const daemon = new AgentDaemon();
await daemon.start();
