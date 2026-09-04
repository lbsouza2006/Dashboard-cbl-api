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

const app = express();
app.use(cors()); // ajuste para restringir a origem do seu dashboard em produção

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

// "MMM/AA" a partir de "YYYY-MM-DD"
function monthLabelFromISO(iso) {
  if (!iso) return null;
  const [y, m] = iso.split("-");
  const meses = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  return `${meses[parseInt(m, 10) - 1]}/${y.slice(2)}`;
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
        cliente: colText(item, NPS_COLS.cliente) || item.name,
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
        cliente: item.name,
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
    const rows = [...groups.values()].map((g) => ({
      mes: g.mes,
      empreendimento: g.empreendimento,
      status: "Houve acompanhamento",
      nps: average(g.npsVals),
      csat: average(g.csatVals),
      novos: null, // plugue aqui outra fonte (ex: board de vendas) se tiver esse dado
    }));
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
        { label: "NPS médio geral", value: geral ?? "—", foot: `${months.length} meses` },
        { label: "Melhor mês", value: Number.isFinite(melhor) ? melhor : "—", foot: months[values.indexOf(melhor)] || "" },
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
        { label: "CSAT médio geral", value: geral ?? "—", foot: `${months.length} meses` },
        { label: "Melhor mês", value: Number.isFinite(melhor) ? melhor : "—", foot: months[values.indexOf(melhor)] || "" },
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
        { label: "NPS médio", value: average(npsMes.map((r) => r.nota)) ?? "—", foot: `${npsMes.length} respostas` },
        { label: "CSAT médio", value: average(csatMes.map((r) => r.nota)) ?? "—", foot: `${csatMes.length} respostas` },
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
