# Desafio TWR — Receptor de Postbacks de Vendas

API REST em **TypeScript** para recebimento de webhooks (postbacks) de plataformas de checkout e geração de relatórios consolidados de vendas.

- **URL Pública da Aplicação:** `https://desafio-twr-postbacks.onrender.com`
- **Relatório ao vivo (`GET`):** `https://desafio-twr-postbacks.onrender.com/sales/report`

---

## Como chamar a aplicação

### 1. Enviar um Postback de Venda (`POST /postbacks`)

Registra uma nova transação ou atualiza o estado de uma transação existente.

**Exemplo de requisição (`curl`):**

```bash
curl -X POST https://desafio-twr-postbacks.onrender.com/postbacks \
  -H "Content-Type: application/json" \
  -d '{
    "transaction_id": "chk_987654321",
    "product_name": "Assinatura Anual TWR Play",
    "customer_email": "comprador@exemplo.com",
    "amount": 199.90,
    "currency": "BRL",
    "status": "approved",
    "payment_method": "credit_card",
    "occurred_at": "2026-10-26T18:30:00Z"
  }'
```

**Campos aceitos no `POST /postbacks`:**
- `transaction_id` *(string, obrigatório)*: Identificador único da transação na plataforma de checkout.
- `product_name` *(string, obrigatório)*: Nome do produto comercializado.
- `customer_email` *(string, obrigatório)*: E-mail válido do comprador.
- `amount` *(number, obrigatório)*: Valor da venda (maior que zero, ex: `199.90`).
- `status` *(enum, obrigatório)*: `"pending"` | `"approved"` | `"refunded"` | `"chargeback"` | `"canceled"`.
- `payment_method` *(enum, opcional)*: `"pix"` | `"credit_card"` | `"boleto"` (padrão: `"credit_card"`).
- `currency` *(string, opcional)*: Código ISO de 3 letras (padrão: `"BRL"`).
- `occurred_at` *(string ISO 8601, opcional)*: Data/hora do evento (padrão: horário do recebimento).

**Exemplo de resposta (`201 Created`):**

```json
{
  "message": "Postback processado com sucesso",
  "resolution": "created",
  "data": {
    "transaction_id": "chk_987654321",
    "product_name": "Assinatura Anual TWR Play",
    "customer_email": "comprador@exemplo.com",
    "amount_cents": 19990,
    "amount": 199.9,
    "currency": "BRL",
    "status": "approved",
    "payment_method": "credit_card",
    "occurred_at": "2026-10-26T18:30:00Z"
  }
}
```

---

### 2. Consultar o Relatório de Vendas (`GET /sales/report`)

Retorna o consolidado financeiro, métricas por status, ranking por produto e a listagem de transações.

**Exemplo de requisição (`curl`):**

```bash
curl https://desafio-twr-postbacks.onrender.com/sales/report
```

*(Filtros opcionais via query params: `?status=approved`, `?product_name=Assinatura`, `?start_date=2026-10-01` e `?end_date=2026-10-31`)*

**Exemplo de resposta (`200 OK`):**

```json
{
  "generated_at": "2026-10-26T18:35:10.120Z",
  "summary": {
    "total_transactions": 2,
    "approved_sales_count": 1,
    "net_approved_revenue": 199.9,
    "pending_revenue": 0,
    "lost_to_refunds_and_chargebacks": 97.5,
    "average_ticket": 199.9
  },
  "breakdown_by_status": {
    "approved": { "count": 1, "total_amount": 199.9 },
    "pending": { "count": 0, "total_amount": 0 },
    "refunded": { "count": 1, "total_amount": 97.5 },
    "chargeback": { "count": 0, "total_amount": 0 },
    "canceled": { "count": 0, "total_amount": 0 }
  },
  "breakdown_by_product": [
    {
      "product_name": "Assinatura Anual TWR Play",
      "approved_sales": 1,
      "approved_revenue": 199.9
    }
  ],
  "transactions": [
    {
      "transaction_id": "chk_987654321",
      "product_name": "Assinatura Anual TWR Play",
      "customer_email": "comprador@exemplo.com",
      "amount": 199.9,
      "currency": "BRL",
      "status": "approved",
      "payment_method": "credit_card",
      "occurred_at": "2026-10-26T18:30:00Z",
      "updated_at": "2026-10-26T18:30:05.000Z"
    }
  ]
}
```

---

## Como rodar localmente

```bash
npm install
npm run dev

```

---

## Premissas e Decisões de Arquitetura

Pensando no comportamento real de plataformas de checkout (Hotmart, Stripe, Kiwify, etc.), tomei as seguintes decisões:

1. **Idempotência no recebimento (`transaction_id`):**
   - **Por quê:** Plataformas de checkout operam no modelo *at-least-once delivery*. Se houver oscilação de rede ou timeout, a plataforma reenviará o mesmo postback. Se o receptor apenas fizer um `INSERT` cego, a mesma venda será contabilizada duas vezes no relatório.
   - **Decisão:** O `transaction_id` é chave primária. Reenvios com o mesmo status retornam `200 OK` (`resolution: "idempotent_no_change"`) para que a plataforma pare de tentar reenviar, sem duplicar receitas.

2. **Ciclo de Vida da Transação e Webhooks Fora de Ordem:**
   - **Por quê:** Uma transação muda de estado ao longo do tempo (`pending` → `approved` → `refunded` / `chargeback`). Além disso, em sistemas distribuídos, o webhook de `pending` pode sofrer atraso na fila da plataforma e chegar alguns milissegundos *depois* do webhook de `approved`.
   - **Decisão:** Implementei uma hierarquia de progressão de status (`pending [1]` → `approved [2]` → `refunded/chargeback/canceled [3]`). Transições legítimas atualizam o registro e recalculam o relatório (deduzindo vendas estornadas da receita líquida), enquanto eventos atrasados de menor prioridade são ignorados com segurança (`resolution: "ignored_out_of_order"`).

3. **Aritmética Financeira em Centavos (`amount_cents`):**
   - **Por quê:** Cálculos monetários em ponto flutuante IEEE 754 geram erros clássicos de precisão (ex: `19.90 + 10.20 = 30.099999999999998`).
   - **Decisão:** A API recebe `amount` em formato decimal amigável, mas converte imediatamente para centavos inteiros (`Math.round(amount * 100)`) para armazenamento e agregação, convertendo de volta apenas na serialização do relatório.

4. **Validação Estrita de Contrato com Zod:**
   - **Por quê:** Dados corrompidos ou valores negativos comprometeriam os indicadores financeiros.
   - **Decisão:** Payloads fora do contrato são rejeitados na borda com `400 Bad Request` detalhando exatamente o campo inválido.

---

## O que decidi NÃO fazer (e por quê)

Dentro do escopo de 3 a 4 horas, priorizei a resiliência das regras de negócio e optei deliberadamente por **não** incluir:

1. **Autenticação obrigatória / Verificação de assinatura HMAC no endpoint de POST:**
   - **Motivo:** Em produção real, é indispensável validar um header de assinatura (ex: `X-Webhook-Signature` via HMAC-SHA256) ou token secreto para garantir que a requisição veio realmente do checkout. Decidi deixar a rota pública sem cabeçalho de autenticação obrigatório para facilitar os testes diretos pela equipe avaliadora via URL, evitando atrito com chaves secretas no `curl`.
2. **Fila de mensageria assíncrona (RabbitMQ / BullMQ + Redis):**
   - **Motivo:** Em cenários de Black Friday com milhares de postbacks por segundo, o ideal é o endpoint apenas enfileirar o payload e responder `202 Accepted` em poucos milissegundos. Para o volume deste desafio, o SQLite em modo `WAL` processa milhares de escritas por segundo de forma síncrona sem necessidade de infraestrutura externa de mensageria.
3. **Banco de dados externo gerenciado (PostgreSQL/MySQL):**
   - **Motivo:** Optei pelo SQLite (`better-sqlite3`) para manter a aplicação 100% autocontida e fácil de rodar localmente com um único comando. Como trade-off conhecido em hospedagens gratuitas (como o plano Free do Render), o disco do container é efêmero em caso de *redeploy* ou reinicialização por inatividade prolongada.
4. **Interface Gráfica (Frontend):**
   - **Motivo:** na minha interpretação o foco do desafio é o comportamento do serviço receptor e a consistência dos dados entre o `POST` e o `GET`. Concentrei o tempo em blindar a API contra inconsistências financeiras.