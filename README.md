# claude-usage

Uso do plano Claude — sessão de 5h, semana, semana por modelo, uso por superfície e créditos —
sem abrir o app. Usa o login que o Claude Code já tem neste Mac.

## Instalar

```sh
pnpm install
pnpm build
pnpm link:bin   # cria ~/.local/bin/claude-usage
```

Requer Node 22.12+ e `~/.local/bin` no `PATH`.

## Usar

| Comando | O que faz |
|---|---|
| `claude-usage` | mostra a tela no terminal e sai |
| `claude-usage -w` | tela ao vivo (`r` atualiza, `q` sai) |
| `claude-usage --web` | abre uma janela (Chrome em modo app) servida em `127.0.0.1:7177` |
| `claude-usage --json` | resposta crua da API, pra scripts |

Opções: `-i/--interval <s>` (padrão 60, mínimo 30), `-p/--port <n>`, `--no-open`,
`--idle-exit <s>`, `--color`/`--no-color`. `claude-usage --help` lista tudo.

O `--web` sobe um servidor em segundo plano que encerra sozinho 5 minutos (`--idle-exit`) depois
que a janela fecha. Rodar `--web` de novo reaproveita o servidor que estiver de pé.

## Login e privacidade

- O token vem do Keychain (`Claude Code-credentials`), de `~/.claude/.credentials.json` ou de
  `CLAUDE_CODE_OAUTH_TOKEN`. É só lido: nunca é renovado, gravado ou mostrado.
- Login expirado? Abra o `claude` uma vez (ele renova o login) e rode de novo. Enquanto isso, a
  tela mostra o último dado salvo, com o horário.
- O token só é enviado para `api.anthropic.com`. O cache em `~/.cache/claude-usage/` guarda só os
  números de uso.

## Limites

- Lê o mesmo endpoint que o `/usage` do Claude Code, que não é documentado: pode mudar sem aviso.
- No macOS, só o Keychain padrão do Claude Code; `CLAUDE_CONFIG_DIR` custom não é suportado.
- No máximo uma consulta por intervalo, somando terminal e janela.
