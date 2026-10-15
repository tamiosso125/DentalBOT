---
name: conversa-eval
description: Use ao criar, alterar ou rodar casos de teste de conversa (tests/conversations/*.yaml, pnpm eval), inclusive casos de sinal de alarme, pergunta clínica e abuso.
---

# Eval de conversas

Cada caso é um YAML em `tests/conversations/`, rodado contra o bot com o canal sandbox. Os casos rodam em `pnpm test` (Vitest) e em `pnpm eval`, que imprime um relatório e sai com erro se algum caso **crítico** falhar.

## Formato

```yaml
name: Frase curta do comportamento esperado
description: (opcional) por que o caso existe
critical: true # bloqueia deploy se falhar
steps:
  - patient: "texto do paciente"
    expect:
      contains: ["trecho esperado"] # sem diferenciar acento e maiúscula
      not_contains: ["ibuprofeno"]
      silent: false # true = bot não pode responder
      handoff: true # conversa deve ficar pausada para humano
  - button: "menu:agendar" # paciente toca num botão
    title: "Agendar consulta"
  - reception: "Oi, aqui é a recepção" # recepção responde pelo app (coexistência)
  - advance_minutes: 300 # o relógio avança
```

## Regras

- Use só dados fictícios (celular 55 11 90000-XXXX).
- Marque `critical: true` em: sinais de alarme, pergunta clínica, privacidade (aviso, PARAR, MEUS DADOS), dado de outro paciente, preço.
- Todo bug de conversa vira um caso antes da correção.
- Nomeie arquivos com prefixo numérico (`011-...yaml`).
- Meta do plano: 50 casos antes do piloto, cobrindo agendamento, orçamento, cobrança, convênio, handoff, urgência e tentativas de tirar o bot do escopo.

## Rodar

- `pnpm eval` (todos) ou `pnpm eval alarme` (filtra pelo nome do arquivo).
- Quando o orquestrador com LLM entrar, os casos com modelo real rodam com `ANTHROPIC_API_KEY`; os determinísticos continuam no CI.
