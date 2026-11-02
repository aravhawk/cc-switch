# cc-switch

Switch [Claude Code](https://code.claude.com) between providers with one command. Keep a profile for your Claude subscription, one for Kimi, one for a local Ollama model, one for work on Bedrock, and move between them without editing `settings.json` by hand.

```bash
cc-switch --create kimi --template kimi    # new profile from a provider template
cc-switch work                             # switch back to "work"
```

Supports 40+ providers: Anthropic, open-model labs (Z.ai GLM, Kimi, DeepSeek, MiniMax, Qwen, ...), gateways (OpenRouter, LiteLLM, ...), local servers (Ollama, LM Studio, vLLM, ...) and cloud platforms (Bedrock, Google Cloud, Foundry).

> Anthropic does not support running Claude Code against non-Claude models. Each template follows the provider's own Claude Code documentation, and that provider is who supports it.

## Install

```bash
npm install -g @aravhawk/cc-switch     # or: pnpm add -g @aravhawk/cc-switch
```

Needs Node.js 22.12+ and Claude Code (run it once so `~/.claude/settings.json` exists).

## Quick start

Run `cc-switch` with no arguments for a guided menu: pick a provider from a searchable list, enter your key (hidden), accept or change the models, and optionally test the connection. Or script it:

```bash
cc-switch --create glm   --template zai    --api-key-env ZAI_API_KEY
cc-switch --create local --template ollama --model qwen3.5
cc-switch --create gcp   --template vertex --env ANTHROPIC_VERTEX_PROJECT_ID=my-project

cc-switch --test      # send one tiny request to check endpoint, key and model
cc-switch glm         # switch
cc-switch --list
```

Creating a profile makes it active and saves the profile you were on, so nothing is lost.

## Providers

`cc-switch --providers` prints this list (`--json` for scripts). Providers with several regions or plans take `--endpoint <id>`; the first is the default.

**Anthropic**

| Template | Provider | `--endpoint` choices |
| --- | --- | --- |
| `anthropic` | Anthropic |  |
| `anthropic-api` | Anthropic API key |  |

**Model labs**

| Template | Provider | `--endpoint` choices |
| --- | --- | --- |
| `zai` | Z.ai (GLM) | `global`, `china` |
| `moonshot-api` | Moonshot Kimi (API) | `global`, `china` |
| `kimi-code` | Kimi Code (membership) | `global`, `china` |
| `minimax` | MiniMax | `global`, `china` |
| `deepseek` | DeepSeek |  |
| `alibaba` | Alibaba Cloud Qwen | `payg-intl`, `payg-china`, `coding-plan`, `coding-plan-china`, `token-plan` |
| `xiaomi-mimo` | Xiaomi MiMo | `payg`, `token-plan-cn`, `token-plan-sgp`, `token-plan-eu` |
| `stepfun` | StepFun | `step-plan`, `step-plan-china`, `api` |
| `volcengine` | Volcengine Ark / BytePlus ModelArk | `byteplus`, `volcengine` |
| `tencent` | Tencent Cloud TokenHub | `token-plan`, `token-plan-china`, `payg` |
| `baidu-qianfan` | Baidu Qianfan | `personal`, `team` |
| `longcat` | Meituan LongCat |  |

**Local**

| Template | Provider | `--endpoint` choices |
| --- | --- | --- |
| `ollama` | Ollama (local) |  |
| `lmstudio` | LM Studio |  |
| `llama-cpp` | llama.cpp server |  |
| `vllm` | vLLM |  |
| `sglang` | SGLang |  |
| `docker-model-runner` | Docker Model Runner |  |

**Gateways and routers**

| Template | Provider | `--endpoint` choices |
| --- | --- | --- |
| `openrouter` | OpenRouter |  |
| `vercel` | Vercel AI Gateway |  |
| `huggingface` | Hugging Face |  |
| `zenmux` | ZenMux |  |
| `aihubmix` | AIHubMix |  |
| `requesty` | Requesty | `global`, `eu` |
| `opencode` | OpenCode Zen and Go | `zen`, `go` |
| `litellm` | LiteLLM proxy |  |
| `custom` | Custom endpoint |  |

**Inference hosts**

| Template | Provider | `--endpoint` choices |
| --- | --- | --- |
| `ollama-cloud` | Ollama Cloud |  |
| `fireworks` | Fireworks AI |  |
| `deepinfra` | DeepInfra |  |
| `sambanova` | SambaNova |  |
| `novita` | Novita AI |  |
| `siliconflow` | SiliconFlow | `global`, `china` |
| `atlas-cloud` | Atlas Cloud |  |
| `synthetic` | Synthetic |  |

**Cloud platforms**

| Template | Provider | `--endpoint` choices |
| --- | --- | --- |
| `bedrock` | Amazon Bedrock | `invoke`, `mantle` |
| `vertex` | Google Cloud (Vertex AI) |  |
| `foundry` | Microsoft Foundry |  |
| `anthropic-aws` | Claude Platform on AWS |  |

- Gateways, local servers and some hosts serve many models, so they need `--model <id>`. Others come with recommended models; override with `--model` (every tier) or `--opus-model`, `--sonnet-model`, `--haiku-model`.
- `custom` works with any Anthropic Messages-compatible URL: `cc-switch --create gw --template custom --base-url https://llm.example.com --model my-model`.
- Cloud platforms store no secret. They set the switches Claude Code reads (`CLAUDE_CODE_USE_BEDROCK`, ...) and use your AWS, Google or Azure login.
- Model names change quickly. After upgrading cc-switch, run `cc-switch --refresh <profile>` to apply the newest recommended models (your key is kept).
- Templates replace everything tied to the previous provider so settings never leak between providers. Permissions, hooks, your own `env` values and the `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` opt-out are left alone.

## Commands

| Command | What it does |
| --- | --- |
| `cc-switch` | Interactive menu |
| `cc-switch <name>` | Switch to a profile (same as `--switch <name>`) |
| `--create <name>` | Create a profile from your current settings or a `--template` |
| `--list`, `--current` | List profiles / print the active one |
| `--show [name]` | Provider, models and masked key of a profile |
| `--test [name]` | Check endpoint, key and model |
| `--set-key <name>` | Replace the API key |
| `--refresh <name>` | Re-apply the provider's latest recommended models |
| `--rename <old> <new>`, `--delete <name>` | Rename / delete (the active profile cannot be deleted) |
| `--providers` | List templates |

`--create` options: `--template`, `--endpoint`, `--model`, `--opus-model`, `--sonnet-model`, `--haiku-model`, `--base-url`, `--auth-style token|api-key` (custom only), `--env NAME=VALUE` (repeatable, for cloud region/project), `--full`, `--include`, `--verify` (test right after creating). `--json` works on `--list`, `--current`, `--show`, `--test` and `--providers`. See `cc-switch --help`.

Profile names: letters, numbers, `-` and `_`, up to 64 characters; `help` and `version` are reserved.

## API keys

Keys are stored in plain text in the profile's `settings.json`, where Claude Code reads them. cc-switch writes every file privately (`0600`), never prints a key (`--show` masks it), and only ever sends it to the profile's own base URL. Avoid putting keys in shell history:

```bash
cc-switch --create glm --template zai --api-key-env ZAI_API_KEY
pass show zai | cc-switch --create glm --template zai --api-key-stdin
cc-switch --create glm --template zai          # prompts, input hidden
```

`CC_SWITCH_API_KEY` is used when no key option is given. `--api-key <key>` still works.

## Full profiles

A normal profile swaps `settings.json`. A **full** profile also swaps files you choose, so each provider can have its own instructions, agents and skills:

```bash
cc-switch --create kimi --template kimi --full                      # CLAUDE.md, agents, skills, rules, commands
cc-switch --create kimi --template kimi --full --include CLAUDE.md,skills
```

Choices: `CLAUDE.md`, `agents`, `skills`, `rules`, `commands`, `output-styles`, `workflows`, `keybindings`, `plugins`, `teams`.

When you switch, the outgoing profile's files are saved first. Files the next profile doesn't manage but the previous one did are removed from `~/.claude` (they stay in the old profile, and cc-switch tells you). Files no profile manages are never touched.

## How it works

```
~/.cc-switch/
  state.json                  active profile
  profiles/<name>/
    settings.json             that profile's settings
    profile.json + files      full profiles only
```

Switching saves the live settings into the active profile, writes the target's settings, then updates `state.json`. Writes are atomic, symlinked `settings.json` files are updated in place, and a failed switch or create restores the previous profile. A hard kill (SIGKILL, power loss) mid-switch is not covered.

Claude Code reads `env` from `settings.json`, but variables exported in your shell can conflict, so cc-switch warns if `ANTHROPIC_*` or `CLAUDE_CODE_USE_*` are exported.

Environment variables: `CLAUDE_CONFIG_DIR` (default `~/.claude`), `CC_SWITCH_HOME` (default `~/.cc-switch`), `CC_SWITCH_API_KEY`, `NO_COLOR`.

## Upgrading from v3

- Requires Node.js 22.12+.
- Existing profiles keep working. Run `cc-switch --refresh <profile>` to move to the new provider defaults.
- `--template moonshot` / `kimi` still mean Kimi Code; the Moonshot platform API is `moonshot-api`.
- `--list` is now a table; use `--list --json` in scripts. `--current` is unchanged.

Full list in the [changelog](CHANGELOG.md).

## Development

```bash
pnpm install
pnpm check       # typecheck + tests + build
```

Tests use throwaway directories and never touch your real config. The provider catalog is `src/providers/catalog.ts`; each entry links the docs it was written from. See [CLAUDE.md](CLAUDE.md) for contribution rules.

## License

[MIT](LICENSE)
