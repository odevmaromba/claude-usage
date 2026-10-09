# CLAUDE.md — claude-usage

## Identificação

CLI pessoal: uso do plano Claude (sessão 5h, semana, por modelo, superfície, créditos) com o login
do Claude Code. Categoria `labs`. Node 22, TS strict; só Zod em runtime. Modos: terminal, `-w` ao
vivo, `--web` (janela local), `--json`.

## Mapa

- `src/` — `cli.ts` (bin, só wiring) → `main.ts` (flags, modos). Dados: `credentials.ts`
  (Keychain/arquivo/env) → `usage-api.ts` (GET `/api/oauth/usage`) → `usage-source.ts` (frescor,
  dedupe, 429, cache em disco) → `usage-view.ts` (payload → modelo) → `display.ts` (strings pt-BR
  das duas telas). Telas: `tui.ts`, `web/` (`server`, `page`, `launcher`).
- `test/` — Vitest; `fixtures/` tem payload real (sem segredo).
- Runtime em `~/.cache/claude-usage/` (`last.json`, `backoff.json`, `server.log`; `0600`).

## Comandos

- T0 antes de PR: `pnpm t0` (lint, typecheck, Vitest, build). CircleCI repete no push.
- `pnpm build && pnpm link:bin` → `~/.local/bin/claude-usage`.
- Sem rede/Keychain: `CLAUDE_USAGE_FIXTURE=test/fixtures/usage-2026-10-07.json node dist/cli.js`.

## Decisões locais

- Token OAuth é **só leitura**: nunca renovar (a rotação do refresh token desloga o Claude Code),
  gravar ou logar. Expirou → mostra o cache e manda abrir o `claude`.
- O token só vai pra `api.anthropic.com`, com `redirect: 'error'`.
- Web só em `127.0.0.1`: allowlist de Host (DNS rebinding), `Sec-Fetch-Site`, CSP com nonce,
  só GET/HEAD; DOM só com `textContent`. Texto de fora passa por `stripControl` antes do terminal.
- Risco aceito (Mac de um usuário): API local sem auth — processo local lê e-mail/plano, força
  consulta (piso 5s, nunca num 429) e imita o `/api/health`. O token nunca sai nela.
- Cota: `-w` + `--web` somam ≤1 chamada por intervalo (padrão 300s, mín. 180s) via `last.json`;
  one-shot, `--json` e forçada reaproveitam leitura <60s. Erro não-429 não é compartilhado.
- 429 segura todos (`backoff.json` `{version:1, until, streak}`): 5/10/20/30 min por 429 seguido
  sem leitura boa; `Retry-After` só se maior (teto 1h; o endpoint manda `0`). `-w` tem ritmo fixo
  e acorda no fim com até 30s de jitter. Login vencido/sem credencial aparece antes do 429.
- Keychain: só `Claude Code-credentials`; sem `CLAUDE_CONFIG_DIR` custom no macOS.
- `src/version.ts` acompanha o `package.json`. TypeScript `~5.9` (o typescript-eslint recusa o 7).
  Config do pnpm no `pnpm-workspace.yaml`.

## Divergências

- **Sem Next, banco ou Vercel** — diferente do padrão porque é ferramenta local de um usuário.
- **Sem Playwright/axe** — diferente do padrão porque é página estática; QA no Chrome headless.
- **Env em `src/env.ts`** — diferente do padrão (`lib/env.ts`) porque um CLI não tem `lib/`.
- **Testes em `test/`** — diferente do padrão (`tests/`) por consistência com `labs/jarvis`.
- **Endpoint não documentado, uso pessoal** — diferente do padrão porque não há API pública de
  limites do plano. Parse leniente por seção; codinome (`iguana_necktie`…) fica de fora de
  propósito; shape novo = fixture + teste.

## Ponteiros

`README.md` (uso). Padrão da casa: `~/.claude/CLAUDE.md` + `~/.claude/rules/`.

<!-- contrato-escopo v1 -->
