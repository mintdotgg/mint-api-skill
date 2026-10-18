# Mint API Skill

## Bring 3D creation into your app.

![A sunlit workspace with a retro computer generated with Mint](assets/platform-mint-landing.webp)

This repository has two skills:

- `mint-api` gives coding agents the service-specific Mint API workflow for generation,
  review, polling, retries, assets, derivatives, file delivery, rate limits, and Credits.
- `mint-modeler` lets your coding agent create and revise 3D Models with Mint Modeler for
  you: it generates, waits, downloads the GLB and preview, and reports the Credits used.

## Install

```bash
# Codex
npx skills add mintdotgg/mint-api-skill -a codex -g -y

# Claude Code
npx skills add mintdotgg/mint-api-skill -a claude-code -g -y

# Cursor
npx skills add mintdotgg/mint-api-skill -a cursor -g -y

# Other compatible agents
npx skills add mintdotgg/mint-api-skill -g -y
```

Set `MINT_API_KEY` in the agent's environment, then ask:

```text
Use the mint-api skill to add Mint model generation to this application.
Use the default auto workflow, poll with bounded backoff, and retrieve the model files.
```

## Mint Modeler

The fastest setup is the one-paste setup prompt on the
[Quickstart](https://docs.mint.gg/developers/quickstart): paste it into your coding agent
and it installs the skill, connects your API key, and checks it.

To install only the Modeler skill yourself:

```bash
npx skills add mintdotgg/mint-api-skill --skill mint-modeler -g -y
```

Then connect your key without pasting it into chat (create one at
[platform.mint.gg](https://platform.mint.gg) under **API keys**):

```bash
node <skills folder>/mint-modeler/scripts/mint-modeler.mjs login   # the folder the installer printed
```

Ask your agent:

```text
Make a small low-poly coffee mug, Low quality.
```

The skill confirms the quality tier before paid work, downloads the GLB and preview
to `./mint-models`, and reports the operation ID and Credits charged.

Documentation: [docs.mint.gg/developers/quickstart](https://docs.mint.gg/developers/quickstart)
