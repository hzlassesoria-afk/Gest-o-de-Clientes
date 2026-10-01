# Gestão de Clientes

Uma página por cliente, com abas. Primeiro cliente: **Petra Seguros**.

```
npm start        # http://localhost:3000   (Node 18+, sem dependências)
npm test
```

## Abas da página do cliente
1. **Métricas do Projeto** – resultado do cliente (investimento no Meta, leads, CPL, qualificados, CPL qualificado, respostas ao 1º contato, cotações, pararam de responder pós follow-up, negociações, vendas, ticket médio, ROAS, CAC) + funil + gestão (tempo de projeto, inadimplência, MRR, Time to Value, NPS, Health Score, índice de reclamação, reuniões de alinhamento, nível de ansiedade, dinheiro coletado) + evolução mensal.
2. **Entrada de Clientes (Monday)** – dados do cliente puxados do quadro do Monday.

## Como os números entram
Você lança só os **valores brutos** de cada mês ("Registrar dados do mês"). CPL, CPL qualificado, ticket médio, ROAS, CAC, taxas e Time to Value são calculados (`public/metrics.js`). No período "Acumulado" as razões são recalculadas a partir dos totais, não pela média dos meses.

Definições:
- **ROAS** = receita gerada em vendas ÷ investimento no Meta
- **CAC** = (investimento + mensalidade da agência) ÷ vendas — a mensalidade pode ser desligada em "Dados do projeto"
- **Taxa de inadimplência** = valor inadimplente ÷ valor faturado
- **Índice de reclamação** = reclamações ÷ contatos do cliente
- **Ansiedade** = contatos espontâneos por semana: ≤ 2 Baixo, ≤ 5 Médio, > 5 Alto
- **Time to Value** = contrato → campanhas no ar; campanhas → 1ª venda (datas em "Dados do projeto")
- **Health Score** = média ponderada de NPS, ROAS vs. meta, inadimplência, ansiedade, reuniões e reclamações (só entram os itens com dado). Um valor manual no mês substitui o cálculo.

## Integração com o Monday
Defina um token pessoal (Monday → avatar → Developers → My access tokens):

```
MONDAY_API_TOKEN=... npm start
```

"Sincronizar com o Monday" procura o quadro **Entrada de Clientes**, acha o item com o nome do cliente, guarda todas as colunas preenchidas e preenche os campos *vazios* do projeto (MRR e datas) quando o título da coluna combina (ver `FIELD_HINTS` em `lib/monday.js`). Para forçar uma coluna, use `monday.fieldMap` no cliente, ex.: `{"mrr": "Valor Mensalidade"}`.

## Dados
Ficam em `data/clients.json` (criado a partir de `seed/clients.json` na primeira execução e ignorado pelo git). Use `DATA_DIR` para mudar o local e `PORT` para a porta.
