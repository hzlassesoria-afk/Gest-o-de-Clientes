# Gestão de Clientes

Uma página por cliente, com abas. Primeiro cliente: **Petra Seguros**.

```
npm start        # http://localhost:3000   (Node 18+, sem dependências)
npm test
```

## Abas da página do cliente
1. **Métricas do Projeto** – resultado do cliente (investimento no Meta, leads, CPL, qualificados, CPL qualificado, respostas ao 1º contato, cotações, pararam de responder pós follow-up, negociações, vendas, ticket médio, ROAS, CAC) + funil + gestão (tempo de projeto, inadimplência, MRR, Time to Value, NPS, Health Score, índice de reclamação, reuniões de alinhamento, nível de ansiedade, dinheiro coletado) + evolução mensal.
2. **Metas (Rotina Comercial)** – meta do mês que se desdobra sozinha em semanas e dias úteis (ver abaixo).
3. **Entrada de Clientes (Monday)** – dados do cliente puxados do quadro do Monday.

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

## Metas da rotina comercial (mensal → semanal → diário)
Em "Definir meta do mês" você informa o valor investido e, para **cada etapa do funil** (leads, leads qualificados, cotações, negociações, vendas), escolhe como definir a meta:
- **Número exato** (ex.: 20 vendas);
- **Porcentagem** da etapa anterior que tem meta (ex.: vendas = 25% das negociações);
- **Custo** por unidade, em R$ (meta = investimento ÷ custo; ex.: custo por venda R$ 300 com R$ 6.000 → 20 vendas).

Ao lado de cada etapa aparece o que a escolha equivale nas outras formas (número, custo e %). Leads só aceitam número ou custo; os leads qualificados aceitam as três. Depois lança **só o realizado** de cada dia (investimento, leads, leads qualificados, cotações, negociações, vendas); o resto é calculado (`public/goals.js`).

- **Dias úteis**: seg–sex. Feriados nacionais (inclui Sexta-feira Santa) já entram como folga; use "marcar folga" no cabeçalho do dia para ajustar. As semanas são as semanas do calendário (seg–sex) que têm dia útil no mês, então um mês pode ter 4 a 6.
- **Meta-base**: meta do mês ÷ dias úteis, proporcional aos dias úteis de cada semana.
- **Compensação**: meta da semana = (meta do mês − realizado até a semana anterior) ÷ dias úteis que faltam × dias úteis da semana. Meta do dia = (meta da semana − realizado na semana até ontem) ÷ dias úteis que faltam na semana. Ficou abaixo → a meta seguinte sobe (▲). Superou → a meta seguinte não cai abaixo da base (opção na meta do mês faz ela cair).
- **Dia sem lançamento** no passado conta como zero (e é avisado); hoje e o futuro são projetados como "meta batida".
- **Linhas de custo** (por lead, por lead qualificado e, quando você escolhe custo, por cotação, negociação ou venda) são tetos fixos: a meta de custo é a mesma em todos os níveis; o realizado é investimento ÷ quantidade do período (razão dos totais, nunca média de médias). Leads e leads qualificados entram como linhas de apoio, com meta = investimento ÷ custo.
- Metas de cotação, negociação e vendas podem ficar fracionadas (ex.: 0,5 venda/dia) — é o ritmo diário esperado.

## Integração com o Monday
Defina um token pessoal (Monday → avatar → Developers → My access tokens):

```
MONDAY_API_TOKEN=... npm start
```

"Sincronizar com o Monday" procura o quadro **Entrada de Clientes**, acha o item com o nome do cliente, guarda todas as colunas preenchidas e preenche os campos *vazios* do projeto (MRR e datas) quando o título da coluna combina (ver `FIELD_HINTS` em `lib/monday.js`). Para forçar uma coluna, use `monday.fieldMap` no cliente, ex.: `{"mrr": "Valor Mensalidade"}`.

## Dados
Ficam em `data/clients.json` (criado a partir de `seed/clients.json` na primeira execução e ignorado pelo git). Use `DATA_DIR` para mudar o local e `PORT` para a porta.
