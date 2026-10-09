# CLAUDE.md — claude-usage

## Identificação

CLI pessoal que mostra o uso do plano Claude (sessão 5h, semana, semana por modelo, superfície,
créditos) sem abrir o app, com o login do Claude Code. Categoria `labs`. Node 22, TS strict; só
Zod em runtime. Modos: tela no terminal, `-w` ao vivo, `--web` (janela local), `--json`.

## Mapa

- `src/` — `cli.ts` (bin, só wiring) → `main.ts` (flags e modos). Dados: `credentials.ts`
  (Keychain/arquivo/env) → `usage-api.ts` (GET `/api/oauth/usage`) → `usage-source.ts` (frescor,
  dedupe, backoff 429, cache em disco) → `usage-view.ts` (payload → modelo) → `display.ts`
  (strings pt-BR, mesmas no terminal e na web). Telas: `tui.ts`, `web/` (`server`, `page`,
  `launcher`).
- `test/` — Vitest; `fixtures/` tem payload real capturado (sem segredo).
- Runtime em `~/.cache/claude-usage/` (`last.json`, `backoff.json`, `server.log`; `0600`), fora do
  repo.

## Comandos

- T0 antes de PR: `pnpm t0` (lint, typecheck, Vitest, build).
- `pnpm build && pnpm link:bin` → `~/.local/bin/claude-usage`.
- Sem rede/Keychain: `CLAUDE_USAGE_FIXTURE=test/fixtures/usage-2026-10-07.json node dist/cli.js`.

## Decisões locais

- Token OAuth é **só leitura**: nunca renovar (a rotação do refresh token desloga o Claude Code),
  gravar ou logar. Expirou → mostra o cache e manda abrir o `claude`.
- O token só vai pra `api.anthropic.com`, com `redirect: 'error'`.
- Endpoint não documentado: parse leniente por seção; chave com codinome (`iguana_necktie`…) fica
  de fora de propósito. Shape novo = fixture nova + teste.
- Web só em `127.0.0.1`: allowlist de Host (DNS rebinding), `Sec-Fetch-Site`, CSP com nonce,
  só GET/HEAD; DOM só com `textContent`. Texto de fora passa por `stripControl` antes do terminal.
- Risco aceito (Mac de um usuário): API local sem autenticação — processo local lê e-mail/plano,
  força consulta (piso 5s; leitura com menos de 60s é reaproveitada; nunca durante um 429) e pode
  imitar o `/api/health`. O token nunca sai nela.
- No máximo 1 chamada à API por intervalo (padrão 300s, mínimo 60s) somando `-w` e `--web`, via
  `last.json`; one-shot/`--json` reaproveitam leitura com menos de 60s. Erro que não é 429 não é
  compartilhado: cada processo tenta de novo no seu intervalo.
- Um 429 segura todos os processos (`backoff.json` = `{version:1, until, streak}`): 5, 10, 20,
  30 min por 429 seguido sem leitura boa; `Retry-After` só vale se for maior (teto 1h) — o endpoint
  manda `0`. Login vencido/sem credencial aparece antes do 429.
- Keychain: só o serviço padrão `Claude Code-credentials`; `CLAUDE_CONFIG_DIR` custom no macOS
  não é suportado.
- `src/version.ts` acompanha o `package.json`. TypeScript `~5.9` (o typescript-eslint recusa o 7).
  Config do pnpm no `pnpm-workspace.yaml`.

## Divergências

- **Sem Next, banco ou Vercel** — diferente do padrão porque é ferramenta local de um usuário.
- **Sem Playwright/axe** — diferente do padrão porque é uma página estática; QA visual na mão
  (Chrome headless).
- **Env em `src/env.ts`** — diferente do padrão (`lib/env.ts`) porque um CLI não tem `lib/`.
- **Testes em `test/`** — diferente do padrão (`tests/`) por consistência com `labs/jarvis`.
- **Endpoint não documentado, uso pessoal** — diferente do padrão porque não há API pública de
  limites do plano; pode quebrar sem aviso.
- **Sem CI** — diferente do padrão porque o repo é local, sem remote; T0 na mão.

## Ponteiros

`README.md` (uso). Padrão da casa: `~/.claude/CLAUDE.md` + `~/.claude/rules/`.

<!-- contrato-escopo v1 -->
