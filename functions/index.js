const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// A chave fica guardada como secret do Firebase, nunca aparece no código
// nem no front-end. Configurada via: firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const REGION = "southamerica-east1"; // São Paulo — menor latência pro Brasil

async function callClaude(apiKey, body) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Erro da API Anthropic: ${response.status}`);
  }
  return data;
}

// Extrai o primeiro bloco de texto da resposta do Claude e tenta isolar o JSON dele
function extrairJson(claudeResponse) {
  const textBlock = (claudeResponse.content || []).find((b) => b.type === "text");
  let raw = textBlock ? textBlock.text : "";
  raw = raw.replace(/```json|```/g, "").trim();
  const match = raw.match(/[\{\[][\s\S]*[\}\]]/);
  if (!match) throw new Error("Resposta do Claude não contém JSON reconhecível");
  return JSON.parse(match[0]);
}

// Endpoint 1: recebe o print ou PDF da fatura, devolve as compras já extraídas
exports.parseFatura = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: true, region: REGION },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }
    try {
      const { imageBase64, mediaType } = req.body || {};
      if (!imageBase64 || !mediaType) {
        return res.status(400).json({ error: "imageBase64 e mediaType são obrigatórios" });
      }

      const isPdf = mediaType === "application/pdf";
      const conteudoArquivo = isPdf
        ? { type: "document", source: { type: "base64", media_type: mediaType, data: imageBase64 } }
        : { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } };

      const claudeResponse = await callClaude(ANTHROPIC_API_KEY.value(), {
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: [
              conteudoArquivo,
              {
                type: "text",
                text:
                  'Esta é uma fatura de cartão de crédito. Extraia cada linha de compra e retorne APENAS um array JSON, sem markdown, sem texto antes ou depois, no formato: [{"descricao": string, "valor_parcela": number, "parcela_atual": number, "parcela_total": number}]. Se a compra não for parcelada, use parcela_atual: 1, parcela_total: 1. Use ponto como separador decimal no valor. Se a fatura tiver várias páginas, extraia as compras de todas elas.',
              },
            ],
          },
        ],
      });

      const itens = extrairJson(claudeResponse);
      res.status(200).json({ itens });
    } catch (err) {
      logger.error("Erro em parseFatura:", err);
      res.status(500).json({ error: err.message || "Erro ao processar a fatura" });
    }
  }
);

// Endpoint 2: recebe o texto transcrito da fala, devolve os campos do lançamento
exports.parseVoz = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: true, region: REGION },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }
    try {
      const { texto } = req.body || {};
      if (!texto) {
        return res.status(400).json({ error: "texto é obrigatório" });
      }

      const prompt =
        'Interprete esta frase em portugues falada por uma empreendedora sobre um lancamento financeiro e retorne APENAS um JSON, sem markdown, sem texto antes ou depois, no formato exato: {"tipo": "receita" ou "despesa", "natureza": "fixa" ou "variavel", "descricao": string curta, "valor": number, "categoria": string curta}. Frase: "' +
        texto +
        '". Regras: se a frase menciona recebimento, venda, pagamento de cliente = receita. Se menciona gasto, compra, pagamento de conta = despesa. Se nao indicar claramente fixa ou variavel, assuma variavel. Valor deve ser so o numero, sem R$.';

      const claudeResponse = await callClaude(ANTHROPIC_API_KEY.value(), {
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      });

      const lancamento = extrairJson(claudeResponse);
      res.status(200).json({ lancamento });
    } catch (err) {
      logger.error("Erro em parseVoz:", err);
      res.status(500).json({ error: err.message || "Erro ao interpretar o áudio" });
    }
  }
);