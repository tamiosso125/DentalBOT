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
  - clinic_books: { procedureId: proc_avaliacao, at: "2026-10-20T14:00" } # recepção marca (hora da clínica)
  - run_reminders: true # roda o lembrete de consulta da véspera
    expect:
      contains: ["amanhã, terça-feira, 20/10 às 14:00"]
  - button: "appt:{appointment}:confirm" # {appointment} = última consulta da agenda
    title: "Confirmar"
    expect:
      appointment_status: CONFIRMED # status da última consulta
```

Orçamentos usam `clinic_sends_quote` e o botão `quote:{quote}:accept`; veja os casos 022 a 027.

### Casos com o Claude (`ai: true`)

```yaml
name: Paciente agenda limpeza
ai: true # liga roteador + atendente
steps:
  - patient: "queria marcar uma limpeza"
    model: # o que o Claude responde no modo offline (ignorado com --live)
      route: agenda # resposta do roteador (Haiku)
      replies: # chamadas do atendente (Sonnet), em ordem
        - tool: listar_horarios
          input: { procedimento: "limpeza" }
        - text: "Escolha um horário na lista abaixo."
    expect:
      list: true # bot mandou lista de horários
      appointments: 0 # consultas ativas na agenda depois do passo
  - list: "slot:2" # paciente toca na opção 2 da lista
    title: "seg 19/10 14:00"
```

O relógio dos casos começa na segunda 19/10/2026 às 09:00 (São Paulo), com a clínica fictícia de `demoAgendaSeed()`. No modo offline o texto do modelo é roteirizado, então o caso testa ferramentas, guarda e efeitos na agenda; a qualidade da conversa se mede com `--live`. Um roteiro que sobra (resposta não usada) é falha: o fluxo seguiu outro caminho.

## Regras

- Use só dados fictícios (celular 55 11 90000-XXXX).
- Marque `critical: true` em: sinais de alarme, pergunta clínica, privacidade (aviso, PARAR, MEUS DADOS), dado de outro paciente, preço.
- Todo bug de conversa vira um caso antes da correção.
- Nomeie arquivos com prefixo numérico (`011-...yaml`).
- Meta do plano: 50 casos antes do piloto (atingida), cobrindo agendamento, orçamento, cobrança, convênio, handoff, urgência e tentativas de tirar o bot do escopo.

## Rodar

- `pnpm eval` (todos) ou `pnpm eval alarme` (filtra pelo nome do arquivo).
- `pnpm eval --live` roda os casos `ai: true` com o Claude real (precisa de `ANTHROPIC_API_KEY`, custa centavos). O CI roda só o modo offline.
