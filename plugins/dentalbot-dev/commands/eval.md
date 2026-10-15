---
description: Roda o eval de conversas e resume as falhas
argument-hint: "[filtro opcional pelo nome do arquivo]"
---

Rode `pnpm eval $ARGUMENTS` na raiz do repositório. Resuma em pt-BR quantos casos passaram, quais falharam (separando os críticos) e a causa provável de cada falha, lendo o caso em `tests/conversations/` e o código em `src/conversation/`.
