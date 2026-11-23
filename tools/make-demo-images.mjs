// Writes the shared demo pictures: /demo-img/<name>.svg (product pictures, ~1 KB each, cached by the browser and the edge for a week) and
// public-site/img/demo-<key>.svg (the gallery cards). Re-run after adding a picture name to functions/api/_demo-seeds.js.
//   node tools/make-demo-images.mjs
import fs from 'node:fs';
import { SEED_BUILDERS } from '../functions/api/_demo-seeds.js';
import { SHARED_DEMOS } from '../functions/api/_shared-demos.js';

const EMO = { maize: '🌽', rice: '🍚', oil: '🛢️', sugar: '🧂', flour: '🌾', veg: '🍅', basin: '🪣', coil: '🌀', charcoal: '⬛', candle: '🕯️', soap: '🧼', paste: '🦷', lotion: '🧴', pads: '🩹', detergent: '🧺', bleach: '🧴', dish: '🍽️', biscuit: '🍪', crisps: '🥔', nuts: '🥜', soda: '🥤', milk: '🥛', tea: '🍵', water: '💧', book: '📓', pen: '🖊️', diaper: '👶', wipes: '🧻', airtime: '📱', battery: '🔋',
  cement: '🧱', steel: '🏗️', wire: '🪢', mesh: '🔳', pipe: '🚰', fitting: '🔧', tap: '🚿', cable: '🔌', switch: '💡', bulb: '💡', paint: '🎨', brush: '🖌️', thinner: '🧪', timber: '🪵', ply: '🪵', roof: '🏠', nails: '📌', screw: '🔩', bolt: '🔩', hammer: '🔨', saw: '🪚', tape: '📏', drill: '🛠️', grinder: '⚙️', tile: '🔲', adhesive: '🪣', lock: '🔒', hinge: '🚪', barrow: '🛒',
  brandy: '🥃', whisky: '🥃', vodka: '🍸', gin: '🍸', rum: '🥃', tequila: '🍹', wine: '🍷', beer: '🍺', crate: '📦', cider: '🍏', rtd: '🥫', juice: '🧃', mixer: '🫧',
  fish: '🐟', stew: '🍲', pilau: '🍛', meat: '🍖', curry: '🥘', samosa: '🥟', soup: '🍜', chips: '🍟', salad: '🥗', coffee: '☕', fruit: '🍉', laundry: '👕', wine2: '🍷',
  pill: '💊', caps: '💊', sachet: '🧪', syrup: '🧴', tube: '💊', plaster: '🩹', bottle: '🧴', inhaler: '🫁', inj: '💉', drip: '💧', lab: '🧪',
  bread: '🍞', mandazi: '🍩', cake: '🎂', scone: '🥐', yoghurt: '🥛', sauce: '🌶️', yeast: '🧫', scissors: '✂️', braid: '💇', treat: '💆', nails2: '💅', facial: '🧖', makeup: '💄', massage: '💆', box: '📦' };
const EMO2 = { car: '🚗', phone: '📱', tools: '🔧', clean: '🧹', stitch: '🧵' };
Object.assign(EMO, EMO2);
const PAL = ['#e0e7ff', '#dcfce7', '#fef3c7', '#fee2e2', '#e0f2fe', '#f3e8ff', '#ffedd5', '#ccfbf1'];
const names = new Set(['box']);
for (const k of Object.keys(SEED_BUILDERS)) {
  const s = SEED_BUILDERS[k](Date.now());
  for (const p of (s.inventory || s.products || [])) if (p.image) names.add(p.image.replace('/demo-img/', '').replace('.svg', ''));
}
fs.mkdirSync('demo-img', { recursive: true });
let n = 0;
for (const nm of names) {
  const bg = PAL[[...nm].reduce((a, c) => a + c.charCodeAt(0), 0) % PAL.length];
  const emo = EMO[nm] || EMO[nm.replace(/\d+$/, '')] || '📦';
  fs.writeFileSync(`demo-img/${nm}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120"><rect width="120" height="120" rx="16" fill="${bg}"/><text x="60" y="78" font-size="56" text-anchor="middle" font-family="Segoe UI Emoji,Apple Color Emoji,Noto Color Emoji,sans-serif">${emo}</text></svg>\n`);
  n++;
}
fs.mkdirSync('public-site/img', { recursive: true });
const ICON = { hospital: '🏥', hotel: '🏨', retail: '🛒', hardware: '🧱', liquor: '🍾', pharmacy: '💊', production: '🏭', services: '💇', water: '💧', carwash: '🚗', phonerepair: '📱', garage: '🔧', barber: '💈', laundry: '👕', cleaning: '🧹', electronics: '📺', tailoring: '🧵' };
const GRAD = { hospital: ['#2f6f55', '#1B2E28'], hotel: ['#C1502E', '#7a2f1a'], retail: ['#4C9A6A', '#1B2E28'], hardware: ['#E8A33D', '#8a5a14'], liquor: ['#7a2f1a', '#1B2E28'], pharmacy: ['#4C9A6A', '#244a3a'], production: ['#E8A33D', '#C1502E'], services: ['#8FA69B', '#1B2E28'], carwash: ['#3E7CB1', '#16324f'], phonerepair: ['#6C5CE7', '#241b5a'], garage: ['#D9822B', '#4a2a0d'], barber: ['#8C2F39', '#2b0f13'], laundry: ['#4FB3BF', '#16454b'], cleaning: ['#5FAD56', '#1d3d1a'], electronics: ['#E4572E', '#4d1b0c'], tailoring: ['#B0527F', '#3b1228'], water: ['#5B8FA6', '#1B2E28'] };
for (const d of SHARED_DEMOS) {
  const [a, b] = GRAD[d.key];
  fs.writeFileSync(`public-site/img/demo-${d.key}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270" width="480" height="270"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="480" height="270" fill="url(#g)"/><circle cx="400" cy="40" r="90" fill="#fff" opacity=".12"/><circle cx="60" cy="250" r="110" fill="#fff" opacity=".1"/><text x="240" y="162" font-size="104" text-anchor="middle" font-family="Segoe UI Emoji,Apple Color Emoji,Noto Color Emoji,sans-serif">${ICON[d.key]}</text></svg>\n`);
}
console.log(n + ' product pictures, ' + SHARED_DEMOS.length + ' gallery cards');
