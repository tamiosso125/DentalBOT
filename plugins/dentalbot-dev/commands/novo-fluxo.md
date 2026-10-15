---
description: Planeja e implementa um fluxo de conversa novo com testes e eval
argument-hint: "<descrição do fluxo>"
---

Fluxo pedido: $ARGUMENTS

1. Peça ao subagent `arquiteto-backend` um plano curto (modelos, ferramentas, estados, textos).
2. Escreva primeiro os casos em `tests/conversations/` (skill `conversa-eval`), incluindo casos críticos.
3. Implemente em `src/conversation/` seguindo o `CLAUDE.md`.
4. Rode `pnpm lint`, `pnpm typecheck`, `pnpm test` e `pnpm eval`.
5. Peça ao subagent `revisor-lgpd` para revisar o diff e corrija os achados.
