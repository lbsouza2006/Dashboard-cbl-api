/**
 * =============================================================================
 * API intermediária: monday.com -> Dashboard CX
 * =============================================================================
 * O que este arquivo faz:
 *  - Consulta o GraphQL do monday.com (mantendo o token seguro no servidor)
 *  - Normaliza os dados dos boards de coleta de NPS e CSAT
 *  - Expõe rotas REST no formato que o dashboard-api.html espera:
 *      GET /meta
 *      GET /overview
 *      GET /timeseries
 *      GET /empreendimentos
 *      GET /nps
 *      GET /csat
 *      GET /coletas-nps
 *      GET /coletas-csat
 *
 * Como rodar:
 *   1) npm install
 *   2) copie .env.example para .env e cole seu token do monday
 *   3) npm start
 *
 * Como publicar (Vercel, Render, Railway, etc.):
 *   - defina a env var MONDAY_API_TOKEN nas configurações do projeto
 *   - aponte CONFIG.API_BASE do dashboard-api.html para a URL pública gerada
 * ============================================================================= */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors()); // ajuste para restringir a origem do seu dashboard em produção
app.use(express.json());

const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

// ---------------------------------------------------------------------------
// IDs reais dos boards e colunas (mapeados na conta A.C.E. Consultoria)
// ---------------------------------------------------------------------------
const NPS_BOARD_ID = 18416987332;   // "Coleta De NPS - CBL"
const CSAT_BOARD_ID = 18383880396;  // "Formulário de satisfação - SAT | CBL - Atualizado"

const NPS_COLS = {
  cliente: "short_textkrr3bp1a",
  nota: "single_selectrigp9yw",
  motivo: "long_textr1zkujgb",
  sugestao: "long_textfjwxbsll",
  data: "datezvwvzho3",
  periodo: "single_selectz223l4x",
  empreendimento: "single_select6theuop",
};

const CSAT_COLS = {
  nota: "single_selectup86txr",
  empreendimento: "single_select9g5abgz",
  sugestao: "short_textol1kcacx",
  data: "date6wi0sprc",
};

// ---------------------------------------------------------------------------
// Login: e-mails autorizados + senha compartilhada
// ---------------------------------------------------------------------------
// IMPORTANTE: para produção, o ideal é mover DASHBOARD_PASSWORD e SESSION_SECRET
// para variáveis de ambiente na Vercel (Project Settings -> Environment Variables),
// em vez de deixá-los fixos aqui no código. Os valores abaixo são o padrão caso
// as variáveis de ambiente não existam.
const ALLOWED_EMAILS = [
  "giovanacravo@aceconsultoria.com.br",
  "luizalapa@aceconsultoria.com.br",
  "laramagalhaes@aceconsultoria.com.br",
  "alicebradley@aceconsultoria.com.br",
  "eng.04@baptistaleal.com.br",
].map((e) => e.toLowerCase());

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "cblace2026*";
const SESSION_SECRET = process.env.SESSION_SECRET || "troque-este-segredo-nas-variaveis-de-ambiente";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // token de acesso válido por 12 horas

function sign(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
}

// Gera um token assinado (e-mail + validade), sem precisar de banco de dados
function issueToken(email) {
  const expires = Date.now() + TOKEN_TTL_MS;
  const payload = `${email}|${expires}`;
  const signature = sign(payload);
  return Buffer.from(`${payload}|${signature}`).toString("base64url");
}

// Confere assinatura, validade e se o e-mail ainda está na lista autorizada
function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [email, expiresStr, signature] = decoded.split("|");
    if (!email || !expiresStr || !signature) return null;

    const expectedSignature = sign(`${email}|${expiresStr}`);
    const validSignature =
      signature.length === expectedSignature.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    if (!validSignature) return null;

    if (Date.now() > Number(expiresStr)) return null;
    if (!ALLOWED_EMAILS.includes(email.toLowerCase())) return null;

    return { email };
  } catch (e) {
    return null;
  }
}

// Middleware: exige um token válido no header "Authorization: Bearer <token>"
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const session = token && verifyToken(token);
  if (!session) return res.status(401).json({ error: "Não autenticado. Faça login novamente." });
  req.user = session;
  next();
}

// ---------------------------------------------------------------------------
// Anonimização do cliente
// ---------------------------------------------------------------------------
// O nome real do cliente nunca deve sair do servidor. Em vez de expor
// colText(item, NPS_COLS.cliente) / item.name, geramos um identificador
// neutro e estável, derivado do id interno do item no monday (não do nome).
function anonymizeClient(itemId) {
  const digits = String(itemId).slice(-4).padStart(4, "0");
  return `Cliente #${digits}`;
}

// ---------------------------------------------------------------------------
// Cliente GraphQL simples
// ---------------------------------------------------------------------------
async function mondayQuery(query, variables = {}) {
  if (!MONDAY_API_TOKEN) throw new Error("MONDAY_API_TOKEN não configurado");
  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": MONDAY_API_TOKEN,
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// Busca todos os items de um board, com paginação, trazendo só as colunas pedidas
async function fetchAllItems(boardId, columnIds) {
  const items = [];
  let cursor = null;

  do {
    const query = `
      query ($boardId: [ID!], $cursor: String, $columnIds: [String!]) {
        boards(ids: $boardId) {
          items_page(limit: 100, cursor: $cursor) {
            cursor
            items {
              id
              name
              column_values(ids: $columnIds) { id text }
            }
          }
        }
      }`;
    const data = await mondayQuery(query, { boardId: [boardId], cursor, columnIds });
    const page = data.boards[0].items_page;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);

  return items;
}

function colText(item, columnId) {
  const c = item.column_values.find((c) => c.id === columnId);
  return c ? (c.text || "").trim() : "";
}

// "MMM/AA" a partir de "YYYY-MM-DD" — já aplicando a competência (mês anterior)
// Regra combinada com a A.C.E.: uma coleta feita em setembro é sobre a
// experiência do cliente em agosto, então ela deve ser rotulada e agrupada
// como "Agosto/2026" em todo o dashboard (KPIs, evolução, filtros, tabelas).
function monthLabelFromISO(iso) {
  if (!iso) return null;
  let [y, m] = iso.split("-").map(Number);
  m -= 1; // desloca para o mês de competência (mês anterior à coleta)
  if (m === 0) { m = 12; y -= 1; }
  const meses = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  return `${meses[m - 1]}/${String(y).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Carregamento e normalização dos dois boards
// ---------------------------------------------------------------------------
async function loadNpsRecords() {
  const items = await fetchAllItems(NPS_BOARD_ID, Object.values(NPS_COLS));
  return items
    .map((item) => {
      const dataISO = colText(item, NPS_COLS.data);
      const notaTxt = colText(item, NPS_COLS.nota);
      return {
        data: dataISO,
        mes: monthLabelFromISO(dataISO),
        cliente: anonymizeClient(item.id),
        empreendimento: colText(item, NPS_COLS.empreendimento) || "Não informado",
        nota: notaTxt ? Number(notaTxt) : null,
        comentario: colText(item, NPS_COLS.motivo) || colText(item, NPS_COLS.sugestao) || "",
      };
    })
    .filter((r) => r.data); // descarta respostas sem data
}

async function loadCsatRecords() {
  const items = await fetchAllItems(CSAT_BOARD_ID, Object.values(CSAT_COLS));
  return items
    .map((item) => {
      const dataISO = colText(item, CSAT_COLS.data);
      const notaTxt = colText(item, CSAT_COLS.nota);
      return {
        data: dataISO,
        mes: monthLabelFromISO(dataISO),
        cliente: anonymizeClient(item.id),
        empreendimento: colText(item, CSAT_COLS.empreendimento) || "Não informado",
        nota: notaTxt ? Number(notaTxt) : null,
        comentario: colText(item, CSAT_COLS.sugestao) || "",
      };
    })
    .filter((r) => r.data);
}

function average(nums) {
  const valid = nums.filter((n) => typeof n === "number" && !Number.isNaN(n));
  if (!valid.length) return null;
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 100) / 100;
}

function sortedMonthKeys(records) {
  // ordena por data real, depois devolve os rótulos únicos em ordem cronológica
  const seen = new Map();
  records
    .slice()
    .sort((a, b) => a.data.localeCompare(b.data))
    .forEach((r) => { if (!seen.has(r.mes)) seen.set(r.mes, r.data); });
  return [...seen.keys()];
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

// Rota de login: fica FORA do requireAuth (é ela que gera o token)
app.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Informe e-mail e senha." });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  if (!ALLOWED_EMAILS.includes(normalizedEmail)) {
    return res.status(401).json({ error: "E-mail não autorizado." });
  }
  if (password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Senha incorreta." });
  }
  const token = issueToken(normalizedEmail);
  res.json({ token });
});

// A partir daqui, toda rota abaixo exige um token válido (ver requireAuth)
app.use(requireAuth);

app.get("/coletas-nps", async (req, res) => {
  try {
    const rows = await loadNpsRecords();
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/coletas-csat", async (req, res) => {
  try {
    const rows = await loadCsatRecords();
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/timeseries", async (req, res) => {
  try {
    const [nps, csat] = await Promise.all([loadNpsRecords(), loadCsatRecords()]);
    const months = [...new Set([...sortedMonthKeys(nps), ...sortedMonthKeys(csat)])];
    res.json({
      months,
      nps: months.map((m) => average(nps.filter((r) => r.mes === m).map((r) => r.nota))),
      csat: months.map((m) => average(csat.filter((r) => r.mes === m).map((r) => r.nota))),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/empreendimentos", async (req, res) => {
  try {
    const [nps, csat] = await Promise.all([loadNpsRecords(), loadCsatRecords()]);
    const key = (r) => `${r.mes}||${r.empreendimento}`;
    const groups = new Map();
    for (const r of nps) {
      const k = key(r);
      if (!groups.has(k)) groups.set(k, { mes: r.mes, empreendimento: r.empreendimento, npsVals: [], csatVals: [] });
      groups.get(k).npsVals.push(r.nota);
    }
    for (const r of csat) {
      const k = key(r);
      if (!groups.has(k)) groups.set(k, { mes: r.mes, empreendimento: r.empreendimento, npsVals: [], csatVals: [] });
      groups.get(k).csatVals.push(r.nota);
    }
    const rows = [...groups.values()].map((g) => {
      const npsValidos = g.npsVals.filter((v) => typeof v === "number");
      const csatValidos = g.csatVals.filter((v) => typeof v === "number");
      const partes = [];
      if (npsValidos.length) partes.push("NPS");
      if (csatValidos.length) partes.push("CSAT");
      return {
        mes: g.mes,
        empreendimento: g.empreendimento,
        nps: average(g.npsVals),
        npsColetas: npsValidos.length,
        csat: average(g.csatVals),
        csatColetas: csatValidos.length,
        acompanhamento: partes.length ? partes.join(" + ") : "Sem coletas",
      };
    });
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/nps", async (req, res) => {
  try {
    const nps = await loadNpsRecords();
    const months = sortedMonthKeys(nps);
    const values = months.map((m) => average(nps.filter((r) => r.mes === m).map((r) => r.nota)));
    const geral = average(nps.map((r) => r.nota));
    const melhor = Math.max(...values.filter((v) => v !== null));
    res.json({
      kpis: [
        { label: "NPS médio geral", value: geral ?? "Sem dados", foot: `${months.length} meses` },
        { label: "Melhor mês", value: Number.isFinite(melhor) ? melhor : "Sem dados", foot: months[values.indexOf(melhor)] || "" },
      ],
      months, values,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/csat", async (req, res) => {
  try {
    const csat = await loadCsatRecords();
    const months = sortedMonthKeys(csat);
    const values = months.map((m) => average(csat.filter((r) => r.mes === m).map((r) => r.nota)));
    const geral = average(csat.map((r) => r.nota));
    const melhor = Math.max(...values.filter((v) => v !== null));
    res.json({
      kpis: [
        { label: "CSAT médio geral", value: geral ?? "Sem dados", foot: `${months.length} meses` },
        { label: "Melhor mês", value: Number.isFinite(melhor) ? melhor : "Sem dados", foot: months[values.indexOf(melhor)] || "" },
      ],
      months, values,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/overview", async (req, res) => {
  try {
    const [nps, csat] = await Promise.all([loadNpsRecords(), loadCsatRecords()]);
    const months = [...new Set([...sortedMonthKeys(nps), ...sortedMonthKeys(csat)])];
    const monthLabel = months[months.length - 1] || "—";

    const npsMes = nps.filter((r) => r.mes === monthLabel);
    const csatMes = csat.filter((r) => r.mes === monthLabel);
    const empreendimentosMes = [...new Set([...npsMes, ...csatMes].map((r) => r.empreendimento))];

    res.json({
      monthLabel,
      source: "monday.com — Coleta De NPS - CBL / Formulário de satisfação SAT",
      kpis: [
        { label: "NPS médio", value: average(npsMes.map((r) => r.nota)) ?? "Sem dados", foot: `${npsMes.length} respostas` },
        { label: "CSAT médio", value: average(csatMes.map((r) => r.nota)) ?? "Sem dados", foot: `${csatMes.length} respostas` },
      ],
      contacts: [
        { label: "Contatos de NPS", value: npsMes.length, desc: "Clientes que responderam a pesquisa de NPS (escala 1–10)." },
        { label: "Contatos de CSAT", value: csatMes.length, desc: "Clientes que responderam o formulário de satisfação (escala 1–5)." },
        { label: "Contatos com empreendimentos", value: empreendimentosMes.length, desc: "Empreendimentos com resposta registrada no mês." },
      ],
      defs: [
        { label: "Empreendimentos acompanhados", value: empreendimentosMes.join(", ") },
      ],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/meta", async (req, res) => {
  try {
    const [nps, csat] = await Promise.all([loadNpsRecords(), loadCsatRecords()]);
    const months = new Set([...sortedMonthKeys(nps), ...sortedMonthKeys(csat)]);
    res.json({
      eyebrow: "A.C.E. Consultoria · CX · Baptista Leal Construtora",
      title: "Comparativo Histórico dos Empreendimentos — CBL",
      subtitle: "Dados ao vivo do monday.com (Coleta de NPS + Formulário de satisfação SAT).",
      badges: [
        { label: "Meses cobertos", value: months.size },
        { label: "Base NPS", value: nps.length },
        { label: "Base CSAT", value: csat.length },
      ],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API rodando em http://localhost:${PORT}`));
