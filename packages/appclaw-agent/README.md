# appclaw-agent

Agent-native command line interface for AppClaw. It exposes deterministic
terminal commands so Claude Code, Gemini CLI, Codex CLI, and other agents can
inspect and operate an Appium-backed mobile session.

```bash
npm install -g appclaw-agent
appclaw-agent help workflow

appclaw-agent --session demo open com.example.app --platform android
appclaw-agent --session demo snapshot -i --json
appclaw-agent --session demo press @e1 --json
appclaw-agent --session demo close
```

The first device command starts a user-local daemon. The daemon owns named
device sessions so separate agent terminal invocations can continue operating
on the same screen.
