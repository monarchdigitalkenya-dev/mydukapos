// functions/api/_capture-shape.js — turns what the AI returned for a photographed / spreadsheet document into the reply the apps read.
// Kept apart from ai-capture-list.js so the rules can be tested without calling the AI.
//
// Three kinds of document:  "items" (an invoice / stock note: quantities and COSTS),  "recipe" (a dish + its ingredient table) and
// "menu" (a restaurant / cafe MENU or price list: dish and drink names, each with ONE price — the SELLING price — and no quantities).

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const conf = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : 0.5);

// zip 232: a time written on a sales sheet -> "HH:MM" (24 h) or "" when it is not a real time; a date -> "YYYY-MM-DD" or "".
function cleanTime(v) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*(am|pm|AM|PM)?\s*$/.exec(String(v || ''));
  if (!m) return '';
  let h = Number(m[1]); const mi = Number(m[2]); const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || mi > 59) return '';
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
function cleanDate(v) {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(String(v || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? m[1] + '-' + m[2] + '-' + m[3] : '';
}

export function shapeCaptureResult(parsed, opts = {}) {
  parsed = parsed || {};
  // A line is usable as long as it has a name OR a code — a delivery sheet that only lists SKUs is just as valid as one with only a name.
  const items = Array.isArray(parsed.items) ? parsed.items
    .filter((it) => it && typeof it === 'object' && (String(it.detected_name || '').trim() || String(it.detected_code || '').trim()))
    .map((it) => ({
      detected_name: String(it.detected_name || '').trim().slice(0, 200),
      detected_code: String(it.detected_code || '').trim().slice(0, 100),
      category: String(it.category || '').trim().slice(0, 80),
      quantity: num(it.quantity),
      unit_cost: num(it.unit_cost),
      retail_price: num(it.retail_price),
      wholesale_price: num(it.wholesale_price),
      confidence_score: conf(it.confidence_score),
      ...(opts.pastSales ? { line_total: num(it.line_total), sold_time: cleanTime(it.sold_time), sold_date: cleanDate(it.sold_date) } : {}),
    })) : [];

  // An ingredient line with no name at all isn't usable (unlike an items line, which can lean on a code).
  const recipes = Array.isArray(parsed.recipes) ? parsed.recipes
    .filter((r) => r && typeof r === 'object' && String(r.dish_name || '').trim())
    .map((r) => ({
      dish_name: String(r.dish_name || '').trim().slice(0, 200),
      yield_qty: num(r.yield_qty),
      selling_price: num(r.selling_price),
      ingredients: Array.isArray(r.ingredients) ? r.ingredients
        .filter((ing) => ing && typeof ing === 'object' && String(ing.name || '').trim())
        .map((ing) => ({
          name: String(ing.name || '').trim().slice(0, 200),
          unit: String(ing.unit || '').trim().slice(0, 20),
          quantity: num(ing.quantity),
          unit_cost: num(ing.unit_cost),
          confidence_score: conf(ing.confidence_score),
        })) : [],
    }))
    .filter((r) => r.ingredients.length > 0) : [];

  // Trust the presence of usable recipes over the model's own label — a stray label shouldn't hide a recipe that was read out correctly.
  let document_type = recipes.length > 0 ? 'recipe' : 'items';

  if (document_type === 'items' && items.length > 0) {
    // A MENU: the model said so (or the person said so), and the lines really look like one — most have a price, none is a bulk quantity.
    const priced = items.filter((it) => it.retail_price > 0 || it.unit_cost > 0).length;
    const looksLikeMenu = priced >= Math.ceil(items.length * 0.6) && items.every((it) => it.quantity <= 1);
    if ((parsed.document_type === 'menu' || opts.menu) && looksLikeMenu) {
      document_type = 'menu';
      // On a menu the printed price IS the selling price. (Currency-tagged numbers such as "KSH 50" were being read as a buying cost.)
      items.forEach((it) => {
        if (!(it.retail_price > 0) && it.unit_cost > 0) it.retail_price = it.unit_cost;
        it.unit_cost = 0; it.wholesale_price = 0; it.quantity = 0;
      });
    }
  }
  return { document_type, items, recipes };
}
