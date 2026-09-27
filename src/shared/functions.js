// CANONICAL SHARED FUNCTIONS — edit here, then run `npm run sync` to write them into every app.
// Only functions that were byte-identical in every app that has them live here. Each app
// lists which of these it uses in the header of its "@shared" region.

//@fn _codeMatches
function _codeMatches(code, q){
        if(!q) return false;
        code = String(code||''); q = String(q);
        return _normCode(code).includes(_normCode(q)) || code.toLowerCase().includes(q.toLowerCase());
    }

//@fn _normCode
function _normCode(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }

//@fn activeServerName
function activeServerName() {
            if (currentServer) return currentServer.name;
            return (ownerName || '').trim() || 'Admin';
        }

//@fn addBulkRow
function addBulkRow() {
            bulkAddRows.push(makeBulkRow());
            renderBulkAddTable();
        }

//@fn addComboRow
function addComboRow() {
            comboDraft.push({ mode: 'existing', code: '', customName: '', qty: 1 });
            renderComboRows();
        }

//@fn addContractRow
function addContractRow() {
            contractDraft.push({ rowId: contractRowSeq++, name: '', qty: '', price: '' });
            renderContractRows();
        }

//@fn addCrossBranchExchangeItem
function addCrossBranchExchangeItem(branchClientId, branchLabel, code, name, price) {
            const existing = exchangeReplacementItems.find(l => l.code === code && l.branchClientId === branchClientId);
            if (existing) {
                existing.qty += 1;
            } else {
                exchangeReplacementItems.push({
                    code, name, price, wholesalePrice: 0, unit: 'pcs', qty: 1,
                    isCrossBranch: true, branchClientId, branchLabel,
                });
            }
            document.getElementById('exchange-item-search').value = '';
            document.getElementById('exchange-item-search-results').style.display = 'none';
            renderExchangeItemsTable();
            renderExchangeBalance();
            showToast(`Added "${name}" from ${branchLabel}.`);
        }

//@fn addCrossBranchItemToCart
function addCrossBranchItemToCart(branchClientId, branchLabel, code, name, price, saleMode) {
            const cartKey = `xbranch:${branchClientId}:${code}:${saleMode || ''}`;
            if (currentCart[cartKey]) {
                currentCart[cartKey].qty += 1;
            } else {
                currentCart[cartKey] = {
                    code, cartKey, name, price, qty: 1,
                    saleMode: saleMode || undefined,
                    unit: 'pcs',
                    isCrossBranch: true,
                    crossBranchClientId: branchClientId,
                    crossBranchLabel: branchLabel,
                };
            }
            renderCart();
            document.getElementById('sales-search').value = '';
            document.getElementById('search-results').style.display = 'none';
            showToast(`Added “${name}” to cart — from ${branchLabel}.`);
        }

//@fn addDeliveryAgent
function addDeliveryAgent() {
            const errEl = document.getElementById('delivery-agent-error');
            const name = document.getElementById('new-delivery-agent-name-input').value.trim();
            const phone = document.getElementById('new-delivery-agent-phone-input').value.trim();
            if (!name) { errEl.textContent = 'Enter the delivery agent\'s name.'; return; }
            deliveryAgents.push({ id: `dagent-${genSaleId()}`, name, phone });
            document.getElementById('new-delivery-agent-name-input').value = '';
            document.getElementById('new-delivery-agent-phone-input').value = '';
            errEl.textContent = '';
            queuePush();
            renderDeliveryAgentsSettingsList();
            showToast(`"${name}" added as an external delivery agent.`);
        }

//@fn addDeliveryZone
function addDeliveryZone() {
            const errEl = document.getElementById('delivery-zone-error');
            const name = document.getElementById('new-zone-name-input').value.trim();
            const fee = parseFloat(document.getElementById('new-zone-fee-input').value);
            const opCostRaw = document.getElementById('new-zone-opcost-input').value;
            const opCost = opCostRaw === '' ? 0 : parseFloat(opCostRaw);
            if (!name) { errEl.textContent = 'Enter a zone name.'; return; }
            if (isNaN(fee) || fee < 0) { errEl.textContent = 'Enter a valid fee (0 for free).'; return; }
            if (isNaN(opCost) || opCost < 0) { errEl.textContent = 'Enter a valid standard cost, or leave it blank.'; return; }
            deliveryZones.push({ id: `zone-${genSaleId()}`, name, fee, opCost });
            document.getElementById('new-zone-name-input').value = '';
            document.getElementById('new-zone-fee-input').value = '';
            document.getElementById('new-zone-opcost-input').value = '';
            errEl.textContent = '';
            queuePush();
            renderDeliveryZonesList();
            showToast(`"${name}" zone added.`);
        }

//@fn addLoyaltyTier
function addLoyaltyTier() {
            loyaltyTiers.push({ id: genSaleId(), minSpend: 0, maxSpend: null, tokens: 1 });
            renderLoyaltyTiersList();
        }

//@fn addRecipeCaptureIngredient
function addRecipeCaptureIngredient(dishId) {
            const dish = recipeCaptureState.dishes.find(d => d.id === dishId);
            if (!dish) return;
            dish.ingredients.push({ id: 'ing-' + (++recipeCaptureRowSeq), name: '', unit: 'pcs', qty: '', unitCost: '', matchedCode: null, isNew: true });
            renderRecipeCaptureReview();
        }

//@fn addRecipeRow
function addRecipeRow() {
            recipeDraft.push({ code: '', qtyPerUnit: '' });
            renderRecipeRows();
        }

//@fn addSameItemAsReplacement
function addSameItemAsReplacement() {
            if (!selectedReturnItem) return;
            addExchangeReplacementItem(selectedReturnItem.code);
        }

//@fn addTradeCreditManually
function addTradeCreditManually() {
            const partyName = document.getElementById('tc-manual-party-input').value.trim();
            const description = document.getElementById('tc-manual-description-input').value.trim();
            const amount = parseFloat(document.getElementById('tc-manual-amount-input').value);

            if (!partyName) { showToast('Enter the other party’s name.', true); return; }
            if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount.', true); return; }

            tradeCredits.push({
                id: genSaleId(),
                timestamp: new Date().toISOString(),
                partyName,
                direction: tradeCreditDirectionDraft,
                description: description || (tradeCreditDirectionDraft === 'i_owe' ? 'Owed to them' : 'Owed to me'),
                amount,
                status: 'open',
                settledAt: null,
                linkedSaleId: null,
            });
            safeSetItem('pos_trade_credits', JSON.stringify(tradeCredits));
            queuePush();

            document.getElementById('tc-manual-party-input').value = '';
            document.getElementById('tc-manual-description-input').value = '';
            document.getElementById('tc-manual-amount-input').value = '';
            setTradeCreditDirection('i_owe');
            document.getElementById('trade-credit-manual-form').style.display = 'none';
            renderTradeCreditsTab();
            showToast('Entry added.');
        }

//@fn addVariantRow
function addVariantRow() {
            variantsDraft.push({ id: genSaleId(), name: '', code: '', price: '', wholesaleSellingPrice: '', wholesalePrice: '', minimumPrice: '', qty: '', dualUnit: false, unitsPerBox: '', pieceCode: '', piecePrice: '', pieceWholesalePrice: '', pieceQty: '', image: null });
            renderVariantRows();
        }

//@fn addVariantsModalRow
function addVariantsModalRow() {
            variantsModalDraft.push({ id: genSaleId(), name: '', code: '', price: 0, wholesaleSellingPrice: 0, wholesalePrice: 0, qty: 0, dualUnit: false, unitsPerBox: null, pieceCode: '', piecePrice: 0, pieceWholesalePrice: 0, pieceQty: 0 });
            renderVariantsModalList();
        }

//@fn adminHasOpenShift
function adminHasOpenShift() {
            return staffShifts.some(sh => sh.staffId === ADMIN_SHIFT_ID && !sh.clockOut);
        }

//@fn advanceDeliveryStatus
function advanceDeliveryStatus(saleId, source) {
            const record = findDeliveryRecord(saleId, source);
            if (!record) { showToast('Could not find that order.', true); renderDeliveriesTab(); return; }
            record.deliveryStatus = nextDeliveryStatus(record.deliveryStatus || 'assigned');
            queuePush();
            renderDeliveriesTab();
            showToast(`Order ${record.refNumber} marked ${statusLabelFor(record.deliveryStatus)}.`);
        }

//@fn advanceDueDate
function advanceDueDate(dateStr, frequency) {
            const d = new Date(dateStr + 'T00:00:00');
            if (frequency === 'weekly') {
                d.setDate(d.getDate() + 7);
            } else {
                const day = d.getDate();
                d.setDate(1);
                d.setMonth(d.getMonth() + 1);
                const daysInNextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
                d.setDate(Math.min(day, daysInNextMonth));
            }
            return dateKey(d);
        }

//@fn apiUrl
function apiUrl(path) {
            if (!clientToken) return path;
            const sep = path.includes('?') ? '&' : '?';
            return `${path}${sep}c=${encodeURIComponent(clientToken)}`;
        }

//@fn applyExpensesOnlyRestriction
function applyExpensesOnlyRestriction() {
            const topEl = document.getElementById('profits-money-details-top');
            const bottomEl = document.getElementById('profits-money-details-bottom');
            const noteEl = document.getElementById('profits-restricted-note');

            const member = currentServer ? staff.find(s => s.id === currentServer.id) : null;
            const restricted = currentServer && staffExpensesAccessLevel(member) === 'expenses-only';

            if (topEl && bottomEl && noteEl) {
                topEl.style.display = restricted ? 'none' : '';
                bottomEl.style.display = restricted ? 'none' : '';
                noteEl.style.display = restricted ? 'block' : 'none';
            }

            // The Dashboard tab is its own separate lock/role from Profits &
            // Expenses — an owner could grant Dashboard access for an
            // unrelated reason (e.g. low-stock alerts) without meaning to
            // also hand over every revenue figure. Since this account is
            // meant to see nothing but "add an expense", the same
            // restriction applies here too, not just on the Profits tab.
            const dashMoneyEl = document.getElementById('dashboard-money-details');
            const dashNoteEl = document.getElementById('dashboard-restricted-note');
            const dashPrintBtn = document.getElementById('dashboard-print-btn');
            if (dashMoneyEl && dashNoteEl) {
                dashMoneyEl.style.display = restricted ? 'none' : '';
                dashNoteEl.style.display = restricted ? 'block' : 'none';
            }
            if (dashPrintBtn) dashPrintBtn.style.display = restricted ? 'none' : '';
        }

//@fn applyScannedCodeToContract
function applyScannedCodeToContract(code) {
            const product = inventory.find(p => (p.code || '').toLowerCase() === code.toLowerCase())
                || inventory.find(p => (p.pieceCode || '').toLowerCase() === code.toLowerCase());

            if (!product) {
                showToast(`No item found with code "${code}" — type the name in manually.`, true);
                return;
            }
            if (!isSellableProduct(product) || !isStockedProduct(product)) {
                showToast(`"${product.name}" can't be added to a contract.`, true);
                return;
            }

            const existingRow = contractDraft.find(r => r.name.trim().toLowerCase() === product.name.trim().toLowerCase());
            if (existingRow) {
                existingRow.qty = String((parseFloat(existingRow.qty) || 0) + 1);
                renderContractRows();
                focusContractField(existingRow.rowId, 'qty');
                showToast(`${product.name} — quantity now ${existingRow.qty}.`);
                return;
            }

            let row = contractDraft.find(r => !r.name.trim());
            if (!row) {
                row = { rowId: contractRowSeq++, name: '', qty: '', price: '' };
                contractDraft.push(row);
            }
            row.name = product.name;
            row.qty = '1';
            if (activeContractType === 'wholesale' && row.price === '') {
                row.price = String(product.price || 0);
            }

            renderContractRows();
            focusContractField(row.rowId, 'qty');
            showToast(`${product.name} added to the contract.`);
        }

//@fn applySecondaryAdminSettingsGate
function applySecondaryAdminSettingsGate() {
            const allowed = currentAdminSettingsRestriction();
            document.querySelectorAll('.settings-subtab-btn').forEach(btn => {
                const sectionId = btn.dataset.section;
                btn.style.display = (!allowed || allowed.includes(sectionId)) ? '' : 'none';
            });
            if (!allowed) return;
            const activeSection = document.querySelector('.settings-section-content.active');
            if (!activeSection || !allowed.includes(activeSection.id)) {
                showSettingsSection(allowed[0]);
            }
        }

//@fn attemptManualLogin
async function attemptManualLogin() {
            const btn = document.getElementById('auth-choice-login-btn');
            const errEl = document.getElementById('auth-choice-login-error');
            errEl.textContent = '';
            btn.disabled = true; btn.textContent = 'Checking…';
            const adopted = await attemptClaimedLinkAutoLogin();
            btn.disabled = false; btn.textContent = 'Log In — I already have a password';
            if (!adopted) {
                errEl.textContent = "This link doesn't have a password set up yet — use Sign Up instead, or check your connection and try again.";
            }
        }

//@fn attendanceDeviationLabel
function attendanceDeviationLabel(actualISO, expectedHHMM) {
            if (!expectedHHMM || !actualISO) return '';
            const actual = new Date(actualISO);
            const [h, m] = expectedHHMM.split(':').map(Number);
            if (isNaN(h) || isNaN(m)) return '';
            const expected = new Date(actual);
            expected.setHours(h, m, 0, 0);
            const diffMin = Math.round((actual - expected) / 60000);
            if (diffMin === 0) return '';
            return diffMin > 0 ? `Late by ${diffMin}m` : `Early by ${Math.abs(diffMin)}m`;
        }

//@fn attendanceTodayEntry
function attendanceTodayEntry(personKey) {
            const today = attendanceTodayKey();
            const todays = attendanceLog.filter(e => e.personKey === personKey && dateKey(new Date(e.clockIn)) === today);
            if (todays.length === 0) return null;
            return todays.find(e => !e.clockOut) || todays[todays.length - 1];
        }

//@fn attendanceTodayKey
function attendanceTodayKey() { return dateKey(new Date()); }

//@fn autoGenerateBarcodeValue
function autoGenerateBarcodeValue() {
            const existing = new Set([
                ...inventory.map(p => (p.code || '').toUpperCase()),
                ...inventory.filter(p => p.pieceCode).map(p => p.pieceCode.toUpperCase()),
                ...savedBarcodes.map(b => b.value.toUpperCase())
            ]);
            let candidate;
            do {
                candidate = '9' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
            } while (existing.has(candidate));
            document.getElementById('barcode-value-input').value = candidate;
            previewBarcode();
        }

//@fn backToLoginPicker
function backToLoginPicker() {
            showLoginPickerStep();
        }

//@fn base64urlDecode
function base64urlDecode(str) {
            str = str.replace(/-/g, '+').replace(/_/g, '/');
            while (str.length % 4) str += '=';
            const bin = atob(str);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return bytes.buffer;
        }

//@fn base64urlEncode
function base64urlEncode(buf) {
            const bytes = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }

//@fn billFulfillmentBadgeHtml
function billFulfillmentBadgeHtml(b) {
            if (b.fulfillmentType !== 'held_in_shop') return `<span class="status-badge badge-carried">🚶 Carried</span>`;
            return b.inventoryDeducted
                ? `<span class="status-badge badge-carried">🚶 Carried</span>`
                : `<span class="status-badge badge-held">🔒 Held</span>`;
        }

//@fn branchSwitchingAllowed
function branchSwitchingAllowed() {
            return !!myBranchGroupId && isAdminServing();
        }

//@fn broadcastCustomerDisplayChange
function broadcastCustomerDisplayChange(total, change) {
            cdSuppressCartBroadcastUntil = Date.now() + 6000;
            const payload = { mode: 'change', total, change: change || 0, businessName, ts: Date.now() };
            try { safeSetItem('pos_customer_display_state', JSON.stringify(payload)); } catch (e) { /* quota — not fatal */ }
            if (poleDisplayWriter) {
                sendToPoleDisplay(
                    change > 0 ? `Change: KES ${change.toFixed(2)}` : `Total: KES ${total.toFixed(2)}`,
                    'Thank you!'
                );
            }
            setTimeout(broadcastCustomerDisplayCart, 6000);
        }

//@fn buildAlignedRow
function buildAlignedRow(leftPart, rightPart) {
            return leftPart ? `${leftPart} — ${rightPart}` : rightPart;
        }

//@fn buildDrawerKickAsciiString
function buildDrawerKickAsciiString() {
            return String.fromCharCode(0x1B, 0x70, 0x00, 50, 50);
        }

//@fn buildDrawerKickBytes
function buildDrawerKickBytes() {
            return new Uint8Array([0x1B, 0x70, 0x00, 0x19, 0xFA]);
        }

//@fn buildInventoryItemName
function buildInventoryItemName(explicitName, category, code) {
            const trimmedName = (explicitName || '').trim();
            if (trimmedName) return trimmedName;
            const trimmedCategory = (category || '').trim();
            const trimmedCode = (code || '').trim();
            if (trimmedCategory && trimmedCode) return `${trimmedCategory} ${trimmedCode}`;
            return trimmedCode || trimmedCategory || '';
        }

//@fn buildPoleDisplayBytes
function buildPoleDisplayBytes(line1, line2) {
            const encoder = new TextEncoder();
            // Epson-family init: ESC @ (0x1B 0x40). CD5220-family init: FF /
            // Form Feed (0x0C) — both clear the display and home the cursor
            // in their respective families; everything after is identical.
            const initBytes = poleDisplayMode === 'cd5220' ? [0x0C] : [0x1B, 0x40];
            return new Uint8Array([
                ...initBytes,
                ...encoder.encode(padPoleLine(line1, 20)),
                0x0D, 0x0A, // CR LF — move to row 2 col 1
                ...encoder.encode(padPoleLine(line2, 20)),
            ]);
        }

//@fn buildReceiptCanvas
function buildReceiptCanvas(text, opts) {
            opts = opts || {};
            // zip 144: the PDF / shared image uses the SAME laid-out lines as the paper (header and footer centred, items aligned as set),
            // so a shared receipt looks exactly like the printed one.
            let lines;
            const secs = (typeof receiptSectionsFor === 'function') ? receiptSectionsFor(text) : null;
            if (secs && typeof receiptGridLines === 'function') {
                const al = typeof receiptItemAlign !== 'undefined' && (receiptItemAlign === 'center' || receiptItemAlign === 'right') ? receiptItemAlign : 'left';
                lines = [...receiptGridLines(secs.header, 'center'), ...receiptGridLines(secs.items, al), ...receiptGridLines(secs.footer, 'center')];
            } else {
                lines = text.split('\n');   // other documents (statements) keep their own width
            }
            const fontSize = 15;
            const lineHeight = Math.round(fontSize * 1.5);
            const paddingX = 24;
            const paddingY = 24;
            // Browsers cap canvas height (commonly ~16,000-32,000px) —
            // a very long "Full Statement" for a high-volume customer
            // could otherwise silently produce a blank/corrupt image.
            // Truncate to what safely fits and say so, rather than fail
            // quietly; Print still has the complete, untruncated text.
            const MAX_LINES = 900;
            if (lines.length > MAX_LINES) {
                const shown = lines.slice(0, MAX_LINES);
                shown.push(`... truncated (${lines.length - MAX_LINES} more lines) — use Print for the full statement.`);
                lines = shown;
            }
            const maxLineLen = lines.reduce((m, l) => l.length > m ? l.length : m, 32);
            const canvasWidth = opts.width || Math.max(500, Math.round(maxLineLen * fontSize * 0.62) + paddingX * 2);
            const canvasHeight = paddingY * 2 + lineHeight * lines.length;
            const canvas = document.createElement('canvas');
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvasWidth, canvasHeight);
            ctx.fillStyle = '#000000';
            ctx.font = `${fontSize}px 'Courier New', monospace`;
            ctx.textBaseline = 'top';
            lines.forEach((line, i) => ctx.fillText(line, paddingX, paddingY + i * lineHeight));
            return canvas;
        }

//@fn buildSystemPrintCopies
function buildSystemPrintCopies() {
            clearSystemPrintCopies();
            const paper = document.getElementById('receipt-paper');
            const modal = document.getElementById('receipt-modal');
            if (!paper || !modal) return;

            // The original is copy 1 — it needs a page break after it too, unless
            // it's the only one.
            paper.classList.toggle('receipt-copy-break', receiptCopies > 1);

            for (let i = 1; i < receiptCopies; i++) {
                const clone = paper.cloneNode(true);
                clone.removeAttribute('id');
                clone.classList.add('receipt-copy-extra');
                // Every copy but the very last breaks to a new page.
                clone.classList.toggle('receipt-copy-break', i < receiptCopies - 1);
                // Strip duplicate ids from inside the clone so getElementById keeps
                // resolving to the original receipt, not a copy of it.
                clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
                modal.appendChild(clone);
            }
        }

//@fn cancelCartTotalQuote
function cancelCartTotalQuote() {
            cartTotalQuoteEditing = false;
            renderCart();
        }

//@fn captureReviewInventoryOptions
function captureReviewInventoryOptions(selectedId) {
            const pool = inventory.filter(p => p.type !== 'service').slice().sort((a, b) => a.name.localeCompare(b.name));
            let html = `<option value="">✨ New Item</option>`;
            pool.forEach(p => {
                html += `<option value="${escapeHtml(p.code)}" ${p.code === selectedId ? 'selected' : ''}>${escapeQuotes(p.name)}</option>`;
            });
            return html;
        }

//@fn captureScanModalNow
async function captureScanModalNow() {
            const video = document.getElementById('barcode-scan-video');
            if (!scanModalStream || !video || !video.videoWidth) {
                setBarcodeScanModalStatus('Camera isn\'t ready yet — wait a second and try again.');
                return;
            }
            if (!scanModalDetector) {
                setBarcodeScanModalStatus('Live scanning isn\'t supported on this browser — type the code below instead.');
                return;
            }
            const btn = document.getElementById('barcode-scan-capture-btn');
            if (btn) btn.disabled = true;
            setBarcodeScanModalStatus('Reading…');
            try {
                const value = await detectOnceFromScanModal(video);
                if (value) {
                    scanModalLastValue = value;
                    scanModalLastTime = Date.now();
                    setBarcodeScanModalStatus(`Scanned: ${value}`);
                    completeBarcodeScanModal(value);
                    return;
                }
                setBarcodeScanModalStatus('No barcode found in that frame — line it up in the green box, fill as much of the frame as you can, and try again.');
            } catch (e) {
                setBarcodeScanModalStatus('Could not read that frame — try again.');
            } finally {
                if (btn) btn.disabled = false;
            }
        }

//@fn cellLooksNumeric
function cellLooksNumeric(raw) {
            return /^[\s]*[\$@]?\s*-?\d[\d,]*(\.\d+)?\s*(kes|ksh|\/=|=\/|pcs|bales?)?\s*$/i.test(String(raw || '').trim());
        }

//@fn changeCartPrice
function changeCartPrice(key, newValue) {
            const line = currentCart[key];
            if (!line) return;

            const price = parseFloat(newValue);
            if (isNaN(price) || price < 0) {
                showToast('Please enter a valid price.', true);
                renderCart();
                return;
            }

            line.price = price;
            renderCart();
        }

//@fn checkAiCaptureStatus
async function checkAiCaptureStatus() {
            try {
                const res = await fetch(apiUrl('/api/ai-capture-list?status=1'));
                const data = await res.json();
                const badge = document.getElementById('ai-capture-configured-badge');
                const statusMsg = document.getElementById('ai-capture-status-msg');
                const ownKeyFields = document.getElementById('ai-capture-own-key-fields');
                const ownKeyList = document.getElementById('ai-capture-own-key-list');
                if (badge) badge.innerText = data.configured ? (data.source === 'shop' ? '✅ Using your key(s)' : '✅ Available') : '⚠️ Not enabled yet';
                if (statusMsg) {
                    statusMsg.className = data.configured ? 'settings-msg success' : 'settings-msg error';
                    statusMsg.textContent = data.source === 'shop'
                        ? '✅ AI Capture List is using your own saved Gemini API key(s) first, falling back to the platform pool if those run out.'
                        : data.configured
                            ? '✅ AI Capture List is available — powered by the platform\'s shared key pool.'
                            : '⚠️ AI Capture List has not been enabled by the platform admin yet — add your own Gemini API key below to turn it on.';
                }
                if (ownKeyList) {
                    ownKeyList.innerHTML = (data.shopKeys || []).map(k => `
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; background:#eafaf1; border:1px solid #a9dfbf; border-radius:6px; padding:8px 10px;">
                            <span style="font-size:13px;">🔑 ${escapeHtml(k.label || 'My key')} <span style="color:#888;">•••${escapeHtml(k.last4)}</span></span>
                            <button class="settings-small-btn" style="background:var(--danger); color:white; padding:4px 10px;" onclick="removeAiCaptureOwnKey('${k.id}')">Remove</button>
                        </div>
                    `).join('');
                }
                if (ownKeyFields) ownKeyFields.style.display = (data.shopKeys || []).length >= (data.shopKeyMax || 2) ? 'none' : 'block';
                aiCaptureConfigured = !!data.configured;
            } catch (e) {
                // Quiet — Settings just shows the fallback state.
            }
        }

//@fn checkBillReminders
function checkBillReminders() {
            const today = todayLocalDateStr();
            let changed = false;
            bills.forEach(b => {
                if (b.voided || b.closed || !b.dueDate) return;
                const itemsTotal = (b.items || []).reduce((sum, l) => sum + l.price * l.qty, 0);
                const balance = round2(Math.max(0, itemsTotal - (b.amountPaid || 0)));
                if (balance <= 0.005) return;
                const due = new Date(b.dueDate + 'T00:00:00');
                const now = new Date(today + 'T00:00:00');
                const diffDays = Math.round((due - now) / 86400000);
                if (diffDays < 0) {
                    if (b.lastOverdueReminderDate !== today) {
                        createBillNotification('overdue', b);
                        b.lastOverdueReminderDate = today;
                        changed = true;
                    }
                } else if (diffDays <= billReminderDaysBefore) {
                    if (b.lastDueSoonReminderDate !== today) {
                        createBillNotification('due_soon', b);
                        b.lastDueSoonReminderDate = today;
                        changed = true;
                    }
                }
            });
            if (changed) safeSetItem('pos_bills', JSON.stringify(bills));
        }

//@fn checkEtimsStatus
async function checkEtimsStatus() {
            const el = document.getElementById('etims-status');
            if (!el) return;
            try {
                const res = await fetch(apiUrl('/api/etims-config'));
                const cfg = await res.json();

                el.innerHTML = cfg.hasEtimsConfig
                    ? '<p class="settings-msg success">✅ Registered with KRA eTIMS.</p>'
                    : '<p class="settings-msg error">⚠️ Not registered yet — enter your KRA PIN below.</p>';

                const fields = document.getElementById('etims-register-fields');
                const configured = document.getElementById('etims-configured-panel');
                if (fields && configured) {
                    fields.style.display = cfg.hasEtimsConfig ? 'none' : 'block';
                    configured.style.display = cfg.hasEtimsConfig ? 'block' : 'none';
                }
                if (cfg.hasEtimsConfig) {
                    const detailsEl = document.getElementById('etims-configured-details');
                    if (detailsEl) {
                        const envLabel = cfg.etimsEnv === 'production' ? 'Production' : 'Sandbox';
                        detailsEl.textContent = `${cfg.etimsTaxpayerName || 'Taxpayer'} — PIN ${cfg.etimsPin}, Branch ${cfg.etimsBranchId} (${cfg.etimsBranchName || 'branch name not returned'}) — ${envLabel}`;
                    }
                    const toggleEl = document.getElementById('etims-receipts-toggle');
                    if (toggleEl) toggleEl.checked = kraEtimsReceiptsEnabled;
                } else {
                    const envEl = document.getElementById('etims-env-input');
                    if (envEl && cfg.etimsEnv) envEl.value = cfg.etimsEnv;
                    const pinEl = document.getElementById('etims-pin-input');
                    if (pinEl && cfg.etimsPin && !pinEl.value) pinEl.value = cfg.etimsPin;
                    const branchEl = document.getElementById('etims-branch-id-input');
                    if (branchEl && cfg.etimsBranchId) branchEl.value = cfg.etimsBranchId;
                }
            } catch (e) {
                el.innerHTML = '<p class="settings-msg">Could not reach the server to check.</p>';
            }
        }

//@fn checkExistingContractMatch
function checkExistingContractMatch() {
            const name = document.getElementById('contract-name-input').value.trim();
            const phone = document.getElementById('contract-phone-input').value.trim();
            let existing = null;
            if (phone) existing = contracts.find(c => c.phone && c.phone.replace(/\D/g, '') === phone.replace(/\D/g, '') && phone.replace(/\D/g, '').length >= 6);
            if (!existing && name) existing = contracts.find(c => c.name.trim().toLowerCase() === name.toLowerCase());

            const group = document.getElementById('contract-existing-group');
            const hint = document.getElementById('contract-existing-hint');
            const retailBtn = document.getElementById('contract-type-retail-btn');
            const wholesaleBtn = document.getElementById('contract-type-wholesale-btn');

            if (existing) {
                activeContractId = existing.id;
                setContractType(existing.type);
                retailBtn.disabled = true;
                wholesaleBtn.disabled = true;
                group.style.display = 'block';
                hint.textContent = `Adding a new visit to ${existing.name}'s existing ${existing.type === 'wholesale' ? 'Wholesale' : 'Retail'} contract.`;
            } else {
                activeContractId = null;
                retailBtn.disabled = false;
                wholesaleBtn.disabled = false;
                group.style.display = 'none';
            }
        }

//@fn checkForInviteToken
function checkForInviteToken() {
            const params = new URLSearchParams(window.location.search);
            const token = params.get('invite');
            if (!token) return false;

            const invite = pendingInvites.find(i => i.token === token);
            if (!invite) return false; // stale, already used, or wrong link — fall through to normal login

            document.getElementById('registration-screen').style.display = 'none';
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('invite-staff-name').innerText = invite.name;
            document.getElementById('invite-biz-name').innerText = businessName || 'This business';
            document.getElementById('invite-screen').style.display = 'flex';
            document.getElementById('invite-screen').dataset.token = token;
            return true;
        }

//@fn checkImageSearchStatus
async function checkImageSearchStatus() {
            try {
                const res = await fetch(apiUrl('/api/image-search?status=1'));
                const data = await res.json();
                const badge = document.getElementById('image-search-configured-badge');
                const fields = document.getElementById('image-search-config-fields');
                const configuredPanel = document.getElementById('image-search-configured-panel');
                if (badge) badge.innerText = data.configured ? '✅ Saved' : '';
                if (fields) fields.style.display = data.configured ? 'none' : 'block';
                if (configuredPanel) configuredPanel.style.display = data.configured ? 'block' : 'none';
            } catch (e) {
                // Quiet — Settings just shows the entry field as the fallback state.
            }
        }

//@fn checkPaymentGatewayStatus
async function checkPaymentGatewayStatus() {
            const el = document.getElementById('payment-gateway-status');
            if (!el) return;
            try {
                const [stkRes, cfgRes] = await Promise.all([
                    fetch(apiUrl('/api/mpesa-stkpush')),
                    fetch(apiUrl('/api/gateway-config')),
                ]);
                const stkData = await stkRes.json();
                const cfg = await cfgRes.json();

                if (stkData.provider === 'paystack') {
                    el.innerHTML = '<p class="settings-msg success">✅ Using Paystack for the M-Pesa STK prompt.</p>';
                } else if (stkData.provider === 'daraja') {
                    el.innerHTML = '<p class="settings-msg success">✅ Using Safaricom Daraja directly for the M-Pesa STK prompt.</p>';
                } else if (stkData.provider === 'kcb') {
                    el.innerHTML = '<p class="settings-msg success">✅ Using KCB Buni for the M-Pesa STK prompt.</p>';
                } else if (stkData.provider === 'paywave') {
                    el.innerHTML = '<p class="settings-msg success">✅ Using Paywave Express for the M-Pesa STK prompt.</p>';
                } else {
                    el.innerHTML = '<p class="settings-msg error">⚠️ Not configured yet — fill in one of the options below.</p>';
                }

                const paystackBadge = document.getElementById('paystack-configured-badge');
                const darajaBadge = document.getElementById('daraja-configured-badge');
                const kcbBadge = document.getElementById('kcb-configured-badge');
                const paywaveBadge = document.getElementById('paywave-configured-badge');
                if (paystackBadge) paystackBadge.innerText = cfg.hasPaystackKey ? '✅ Saved' : '';
                if (darajaBadge) darajaBadge.innerText = cfg.hasDarajaConfig ? '✅ Saved' : '';
                if (kcbBadge) kcbBadge.innerText = cfg.hasKcbConfig ? '✅ Saved' : '';
                if (paywaveBadge) paywaveBadge.innerText = cfg.hasPaywaveConfig ? '✅ Saved' : '';

                // Once a provider is configured, hide its input fields and show the
                // "configured" panel with a Reset button instead — there's nothing to
                // re-show the saved secret to, so the fields would just sit there empty
                // and confusing.
                const paystackFields = document.getElementById('paystack-config-fields');
                const paystackConfigured = document.getElementById('paystack-configured-panel');
                if (paystackFields && paystackConfigured) {
                    paystackFields.style.display = cfg.hasPaystackKey ? 'none' : 'block';
                    paystackConfigured.style.display = cfg.hasPaystackKey ? 'block' : 'none';
                }
                const darajaFields = document.getElementById('daraja-config-fields');
                const darajaConfigured = document.getElementById('daraja-configured-panel');
                if (darajaFields && darajaConfigured) {
                    darajaFields.style.display = cfg.hasDarajaConfig ? 'none' : 'block';
                    darajaConfigured.style.display = cfg.hasDarajaConfig ? 'block' : 'none';
                }
                const kcbFields = document.getElementById('kcb-config-fields');
                const kcbConfigured = document.getElementById('kcb-configured-panel');
                if (kcbFields && kcbConfigured) {
                    kcbFields.style.display = cfg.hasKcbConfig ? 'none' : 'block';
                    kcbConfigured.style.display = cfg.hasKcbConfig ? 'block' : 'none';
                }
                const paywaveFields = document.getElementById('paywave-config-fields');
                const paywaveConfigured = document.getElementById('paywave-configured-panel');
                if (paywaveFields && paywaveConfigured) {
                    paywaveFields.style.display = cfg.hasPaywaveConfig ? 'none' : 'block';
                    paywaveConfigured.style.display = cfg.hasPaywaveConfig ? 'block' : 'none';
                }

                const paystackUrlEl = document.getElementById('gateway-paystack-webhook-url');
                if (paystackUrlEl) paystackUrlEl.value = cfg.paystackWebhookUrl || '';
                const callbackUrlEl = document.getElementById('gateway-mpesa-callback-url');
                if (callbackUrlEl) callbackUrlEl.value = cfg.mpesaCallbackUrl || '';
                const paywaveUrlEl = document.getElementById('gateway-paywave-webhook-url');
                if (paywaveUrlEl) paywaveUrlEl.value = cfg.paywaveWebhookUrl || '';
                const kcbIpnUrlEl = document.getElementById('gateway-kcb-ipn-url');
                if (kcbIpnUrlEl) kcbIpnUrlEl.value = cfg.kcbIpnUrl || '';
                const paywaveEmailEl = document.getElementById('gateway-paywave-email-input');
                if (paywaveEmailEl && !cfg.hasPaywaveConfig) paywaveEmailEl.value = cfg.paywaveEmail || '';
                const envEl = document.getElementById('gateway-mpesa-env-input');
                if (envEl) envEl.value = cfg.mpesaEnv || 'sandbox';
                const kcbEnvEl = document.getElementById('gateway-kcb-env-input');
                if (kcbEnvEl) kcbEnvEl.value = cfg.kcbEnv || 'sandbox';
                const kcbSharedEl = document.getElementById('gateway-kcb-shared-shortcode-input');
                if (kcbSharedEl) kcbSharedEl.checked = cfg.kcbSharedShortCode !== false;
                const forcedEl = document.getElementById('gateway-forced-provider-input');
                if (forcedEl) forcedEl.value = cfg.forcedProvider || '';

                paymentGatewayStatusChecked = true;
            } catch (e) {
                el.innerHTML = '<p class="settings-msg">Could not reach the server to check — this is normal while working locally without Cloudflare Pages Functions running (use `wrangler pages dev`).</p>';
            }
        }

//@fn checkPrintRelayAvailable
function checkPrintRelayAvailable() {
            // "Is a shop printer waiting to take this job?" A print must never wait on the network for the answer (it used to: a slow or hung
            // request held every receipt back for up to a minute). The answer is remembered for 30 s and refreshed in the background; if a fresh
            // one is not back within 1.2 s the last known answer is used and the receipt prints at once.
            const c = window.__relayAvail || (window.__relayAvail = { at: 0, value: false, pending: null });
            if (Date.now() - c.at < 30000) return Promise.resolve(c.value);
            if (!c.pending) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 6000);
                c.pending = fetch(apiUrl('/api/print-relay'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'checkAvailable' }),
                    signal: controller.signal,
                }).then((res) => res.json().then((data) => !!(res.ok && data.available)))
                    .catch(() => false)
                    .then((v) => { c.value = v; c.at = Date.now(); return v; })
                    .finally(() => { clearTimeout(timer); c.pending = null; });
            }
            return Promise.race([c.pending, new Promise((resolve) => setTimeout(() => resolve(c.value), window.__relayWaitMs || 1200))]);
        }
//@fn claimLicensePayment
async function claimLicensePayment() {
            if (paymentClaimInFlight) return;
            paymentClaimInFlight = true;
            const btn = document.getElementById('license-claim-payment-btn');
            if (btn) { btn.disabled = true; btn.textContent = 'Letting them know…'; }
            try {
                await fetch(apiUrl('/api/license-claim-payment'), { method: 'POST' });
                showToast('Marked as paid — you’ll be upgraded once it’s confirmed.');
                await checkLicenseStatus();
                if (upgradeScreenManuallyOpen) showUpgradeScreen(); // refresh the on-screen text with the new claimed status
            } catch (e) {
                showToast(netErrText('Could not reach the server'), true);
            } finally {
                paymentClaimInFlight = false;
                if (btn) { btn.disabled = false; btn.textContent = 'I’ve made this payment'; }
            }
        }

//@fn clearAuthUrlParams
function clearAuthUrlParams() {
            try {
                const url = new URL(window.location.href);
                let changed = false;
                ['staff', 'invite'].forEach(p => {
                    if (url.searchParams.has(p)) { url.searchParams.delete(p); changed = true; }
                });
                if (changed) window.history.replaceState({}, '', url.toString());
            } catch (e) {
                // Non-fatal — the picker still shows, the URL just keeps its parameter.
            }
        }

//@fn clearInventorySearch
function clearInventorySearch() {
            const inp = document.getElementById('inventory-search-input');
            if (!inp) return;
            clearTimeout(window._invSearchDebounce);
            inp.value = '';
            window._invPage = 1;
            toggleInventorySearchClear();
            renderInventoryTable();
            inp.focus();
        }

//@fn clearMpesaPayerFields
function clearMpesaPayerFields() {
            const phoneInput = document.getElementById('mpesa-phone-input');
            const nameInput = document.getElementById('mpesa-payer-name-input');
            const codeInput = document.getElementById('mpesa-code-input');
            if (phoneInput) phoneInput.value = '';
            if (nameInput) nameInput.value = '';
            if (codeInput) codeInput.value = '';
        }

//@fn clearSystemPrintCopies
function clearSystemPrintCopies() {
            document.querySelectorAll('.receipt-copy-extra').forEach(el => el.remove());
            const paper = document.getElementById('receipt-paper');
            if (paper) paper.classList.remove('receipt-copy-break');
        }

//@fn closeAddCustomerModal
function closeAddCustomerModal() {
            document.getElementById('add-customer-modal').style.display = 'none';
        }

//@fn closeAddPrintRoutingRule
function closeAddPrintRoutingRule() {
            document.getElementById('printer-routing-rule-form').style.display = 'none';
        }

//@fn closeAdhocSaleModal
function closeAdhocSaleModal() {
            document.getElementById('adhoc-sale-modal').style.display = 'none';
        }

//@fn closeAttendanceClockModal
function closeAttendanceClockModal() {
            document.getElementById('attendance-clock-modal').style.display = 'none';
            pendingAttendancePersonKey = null;
        }

//@fn closeBarcodeScanModal
function closeBarcodeScanModal() {
            if (scanModalIntervalId) { clearInterval(scanModalIntervalId); scanModalIntervalId = null; }
            if (scanModalStream) { scanModalStream.getTracks().forEach(t => t.stop()); scanModalStream = null; }
            scanModalTrack = null;
            scanModalDetector = null;
            scanModalCanvas = null;
            scanModalCanvasCtx = null;
            scanModalTorchOn = false;
            scanModalTorchSupported = false;
            scanModalOnResult = null;
            const modal = document.getElementById('barcode-scan-modal');
            if (modal) modal.style.display = 'none';
            const video = document.getElementById('barcode-scan-video');
            if (video) video.srcObject = null;
        }

//@fn closeBillHistoryModal
function closeBillHistoryModal() {
            document.getElementById('bill-history-modal').style.display = 'none';
        }

//@fn closeBizImportReviewModal
function closeBizImportReviewModal() {
            document.getElementById('biz-import-review-modal').style.display = 'none';
            bizImportReviewState = null;
        }

//@fn closeCaptureReviewModal
function closeCaptureReviewModal() {
            document.getElementById('capture-review-modal').style.display = 'none';
            captureReviewState = null;
        }

//@fn closeCaptureSourceModal
function closeCaptureSourceModal() {
            stopCaptureListCamera();
            document.getElementById('capture-source-modal').style.display = 'none';
        }

//@fn closeColumnMappingModal
function closeColumnMappingModal() {
            document.getElementById('column-mapping-modal').style.display = 'none';
            columnMappingCallback = null;
        }

//@fn closeContractReturnModal
function closeContractReturnModal() {
            document.getElementById('contract-return-modal').style.display = 'none';
            pendingContractReturnId = null;
        }

//@fn closeDebtModal
function closeDebtModal() { document.getElementById('debt-modal').style.display = 'none'; }

//@fn closeDebtPaymentModal
function closeDebtPaymentModal() { document.getElementById('debt-payment-modal').style.display = 'none'; pendingDebtPaymentId = null; }

//@fn closeDeliveryOrderModal
function closeDeliveryOrderModal() {
            document.getElementById('delivery-order-modal').style.display = 'none';
        }

//@fn closeDeliveryPaymentModal
function closeDeliveryPaymentModal() {
            document.getElementById('delivery-payment-modal').style.display = 'none';
            pendingDeliveryPaymentSaleId = null;
        }

//@fn closeDemoPurgeModal
function closeDemoPurgeModal() {
            document.getElementById('demo-purge-modal').style.display = 'none';
            pendingDemoPurgeOptions = null;
        }

//@fn closeKitchenTicket
function closeKitchenTicket() {
            document.getElementById('kitchen-ticket-modal').style.display = 'none';
        }

//@fn closeKitchenTicketAfterPrint
function closeKitchenTicketAfterPrint() {
            const modal = document.getElementById('kitchen-ticket-modal');
            if (modal && modal.style.display !== 'none') closeKitchenTicket();
        }

//@fn closePromoOfferModal
function closePromoOfferModal() {
            document.getElementById('promo-offer-modal').style.display = 'none';
        }

//@fn closeReceipt
function closeReceipt() {
            document.getElementById('receipt-modal').style.display = 'none';
            try {
                const tab = document.getElementById('sales-tab');
                const search = document.getElementById('sales-search');
                if (search && tab && tab.classList.contains('active') && !('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) search.focus();
            } catch (e) { /* cosmetic */ }
        }

//@fn closeReceiptAfterPrint
function closeReceiptAfterPrint() {
            const modal = document.getElementById('receipt-modal');
            if (modal && modal.style.display !== 'none') {
                closeReceipt();
            }
        }

//@fn closeRecipeCaptureReviewModal
function closeRecipeCaptureReviewModal() {
            document.getElementById('recipe-capture-review-modal').style.display = 'none';
            recipeCaptureState = null;
        }

//@fn closeRecordBillModal
function closeRecordBillModal() {
            document.getElementById('record-bill-modal').style.display = 'none';
        }

//@fn closeRecordPastSaleModal
function closeRecordPastSaleModal() {
            document.getElementById('record-past-sale-modal').style.display = 'none';
        }

//@fn closeSalesReport
function closeSalesReport() {
            document.getElementById('sales-report-modal').style.display = 'none';
        }

//@fn closeStoreImportFromInventoryModal
function closeStoreImportFromInventoryModal() {
            document.getElementById('store-import-modal').style.display = 'none';
        }

//@fn closeTabsOverflowMenu
function closeTabsOverflowMenu() {
            const menu = document.getElementById('tabs-more-menu');
            if (menu) menu.classList.remove('show');
        }

//@fn closeUpgradeScreen
function closeUpgradeScreen() {
            upgradeScreenManuallyOpen = false;
            const lockScreen = document.getElementById('license-lock-screen');
            if (lockScreen) lockScreen.style.display = 'none';
        }

//@fn closeVariantsModal
function closeVariantsModal() {
            document.getElementById('variants-view-modal').style.display = 'none';
            variantsModalCode = null;
            variantsModalDraft = [];
        }

//@fn completeBarcodeScanModal
function completeBarcodeScanModal(code) {
            const cb = scanModalOnResult;
            closeBarcodeScanModal();
            if (typeof cb === 'function') cb(code);
        }

//@fn computeFlatOfferResults
function computeFlatOfferResults(entries) {
            const results = [];
            offers.filter(o => o.active && o.type === 'flat').forEach(offer => {
                const matched = entries.filter(l => lineMatchesOffer(l, offer));
                if (matched.length === 0) return;
                const totalQty = matched.reduce((s, l) => s + l.qty, 0);
                const minQty = Math.max(1, parseInt(offer.minQty, 10) || 1);
                if (totalQty < minQty) return;
                const subtotal = matched.reduce((s, l) => s + l.price * l.qty, 0);
                const flatAmount = parseFloat(offer.flatAmount) || 0;
                const amount = round2(Math.min(flatAmount, subtotal));
                if (amount <= 0) return;
                results.push({ amount, label: `${offer.name || 'Flat Discount'}: KES ${flatAmount} Off`, offerId: offer.id, offerName: offer.name || 'Flat Discount' });
            });
            return results;
        }

//@fn computeLineOfferDiscount
function computeLineOfferDiscount(line, offer) {
            if (!offer.active || !lineMatchesOffer(line, offer)) return null;
            const unitPrice = line.price;
            if (offer.type === 'bogo') {
                const buyQty = Math.max(1, parseInt(offer.buyQty, 10) || 1);
                const freeQty = Math.max(1, parseInt(offer.freeQty, 10) || 1);
                const pct = offer.freeDiscountPercent === '' || offer.freeDiscountPercent == null ? 100 : Math.max(0, Math.min(100, parseFloat(offer.freeDiscountPercent)));
                const sets = Math.floor(line.qty / (buyQty + freeQty));
                if (sets <= 0) return null;
                const amount = round2(sets * freeQty * unitPrice * (pct / 100));
                if (amount <= 0) return null;
                const label = pct >= 100 ? `Buy ${buyQty} Get ${freeQty} Free` : `Buy ${buyQty} Get ${freeQty} at ${pct}% Off`;
                return { amount, label, offerId: offer.id, offerName: offer.name || label };
            }
            if (offer.type === 'percent') {
                const pct = Math.max(0, Math.min(100, parseFloat(offer.percentOff) || 0));
                if (pct <= 0) return null;
                const amount = round2(unitPrice * line.qty * (pct / 100));
                if (amount <= 0) return null;
                return { amount, label: `${pct}% Off`, offerId: offer.id, offerName: offer.name || `${pct}% Off` };
            }
            if (offer.type === 'bundle') {
                const bundleQty = Math.max(2, parseInt(offer.bundleQty, 10) || 2);
                const bundlePrice = parseFloat(offer.bundlePrice);
                if (isNaN(bundlePrice)) return null;
                const bundles = Math.floor(line.qty / bundleQty);
                if (bundles <= 0) return null;
                const original = bundles * bundleQty * unitPrice;
                const bundled = bundles * bundlePrice;
                const amount = round2(original - bundled);
                if (amount <= 0) return null;
                const label = `${bundleQty} for ${money(bundlePrice)}`;
                return { amount, label, offerId: offer.id, offerName: offer.name || label };
            }
            return null;
        }

//@fn computeStaffStats
function computeStaffStats(id) {
            const shifts = staffShiftsFor(id);
            const now = Date.now();
            const today = todayLocalDateStr();
            let totalMs = 0;
            let todayMs = 0;
            const daysSet = new Set();
            let activeShift = null;

            shifts.forEach(sh => {
                const end = sh.clockOut || now;
                const ms = Math.max(0, end - sh.clockIn);
                totalMs += ms;
                const dayStr = new Date(sh.clockIn).toLocaleDateString('en-CA'); // YYYY-MM-DD, local
                daysSet.add(dayStr);
                if (dayStr === today) todayMs += ms;
                if (!sh.clockOut) activeShift = sh;
            });

            return {
                online: !!activeShift,
                onlineSince: activeShift ? activeShift.clockIn : null,
                todayHours: todayMs / 3600000,
                totalHours: totalMs / 3600000,
                daysWorked: daysSet.size,
            };
        }

//@fn computeTokensEarned
function computeTokensEarned(saleTotal) {
            if (!loyaltyEnabled) return 0;
            const tier = loyaltyTiers.find(t => saleTotal >= t.minSpend && (t.maxSpend == null || saleTotal <= t.maxSpend));
            return tier ? tier.tokens : 0;
        }

//@fn confirmAdhocSale
function confirmAdhocSale() {
            const errEl = document.getElementById('adhoc-sale-modal-error');
            const name = document.getElementById('adhoc-sale-name-input').value.trim();
            const price = parseFloat(document.getElementById('adhoc-sale-price-input').value);
            const qty = parseInt(document.getElementById('adhoc-sale-qty-input').value, 10);

            if (!name) { errEl.textContent = 'Enter an item name.'; return; }
            if (isNaN(price) || price < 0) { errEl.textContent = 'Enter a valid selling price.'; return; }
            if (!Number.isInteger(qty) || qty < 1) { errEl.textContent = 'Enter a valid quantity.'; return; }

            const isBorrowed = document.getElementById('adhoc-sale-borrowed-toggle').checked;
            let borrowedFrom = null, amountOwed = null;
            if (isBorrowed) {
                borrowedFrom = document.getElementById('adhoc-borrowed-party-input').value.trim();
                amountOwed = parseFloat(document.getElementById('adhoc-borrowed-amount-input').value);
                if (!borrowedFrom) { errEl.textContent = 'Enter who this was borrowed from.'; return; }
                if (isNaN(amountOwed) || amountOwed < 0) { errEl.textContent = 'Enter a valid amount owed.'; return; }
            }

            const key = 'adhoc-' + genSaleId();
            currentCart[key] = {
                code: null, cartKey: key, name, price, wholesalePrice: 0,
                unit: 'pcs', isService: false, vatCategory: 'A', qty,
                isAdhoc: true, borrowedFrom, amountOwed,
            };

            closeAdhocSaleModal();
            renderCart();
            showToast(`"${name}" added to cart.`);
        }

//@fn connectPoleDisplay
async function connectPoleDisplay() {
            const statusEl = document.getElementById('pole-display-status');
            if (!navigator.serial) {
                statusEl.className = 'settings-msg error';
                statusEl.textContent = 'This browser doesn’t support Serial devices. Use Chrome or Edge on desktop.';
                return;
            }
            try {
                statusEl.className = 'settings-msg';
                statusEl.textContent = 'Choose your pole display from the list…';
                const port = await navigator.serial.requestPort();
                await openPoleDisplayPort(port);
                statusEl.className = 'settings-msg success';
                statusEl.textContent = 'Connected.';
                await sendToPoleDisplay('Welcome!', businessName || 'Thank you');
            } catch (e) {
                statusEl.className = 'settings-msg error';
                const msg = e && e.message ? e.message : '';
                statusEl.textContent = msg.includes('No port selected')
                    ? 'Cancelled.'
                    : `Could not connect: ${msg || 'no further detail given by the browser'}`;
            }
        }

//@fn contractRowLineTotal
function contractRowLineTotal(row) {
            const qty = parseFloat(row.qty) || 0;
            return qty * contractRowUnitPrice(row);
        }

//@fn contractRowProduct
function contractRowProduct(row) {
            // Contracts are customer-facing supply agreements, so raw ingredients
            // are excluded the same way they are at the till.
            return inventory.find(p => isSellableProduct(p) && isStockedProduct(p) && p.name.trim().toLowerCase() === row.name.trim().toLowerCase());
        }

//@fn contractRowUnitPrice
function contractRowUnitPrice(row) {
            if (activeContractType === 'retail') {
                const product = contractRowProduct(row);
                return product ? product.price : 0;
            }
            return parseFloat(row.price) || 0;
        }

//@fn copyGatewayUrl
function copyGatewayUrl(inputId) {
            const input = document.getElementById(inputId);
            if (!input || !input.value) return;
            input.select();
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(input.value);
            } else {
                document.execCommand('copy');
            }
            showToast('Copied.');
        }

//@fn copyInviteLink
function copyInviteLink() {
            const linkInput = document.getElementById('invite-link-text');
            linkInput.select();
            linkInput.setSelectionRange(0, 99999);
            try {
                navigator.clipboard.writeText(linkInput.value);
                showToast('Link copied to clipboard.');
            } catch (e) {
                document.execCommand('copy');
                showToast('Link copied.');
            }
        }

//@fn copySmsWebhookUrl
function copySmsWebhookUrl() {
            const input = document.getElementById('sms-inbound-webhook-url');
            const msgEl = document.getElementById('sms-webhook-copy-msg');
            input.select();
            navigator.clipboard.writeText(input.value).then(() => {
                msgEl.className = 'settings-msg success';
                msgEl.textContent = 'Copied — paste this into Africa’s Talking’s dashboard.';
            }).catch(() => {
                msgEl.className = 'settings-msg';
                msgEl.textContent = 'Select the text above and copy it manually.';
            });
        }

//@fn copyStaffLoginLink
async function copyStaffLoginLink(id, name) {
            const link = `${window.location.origin}${window.location.pathname}?staff=${id}`;
            try {
                await navigator.clipboard.writeText(link);
                showToast(`Login link for ${name} copied — send it to them to bookmark.`);
            } catch (e) {
                window.prompt(`Login link for ${name} — copy this:`, link);
            }
        }

//@fn openStaffLoginLink
function openStaffLoginLink(id) {
            // The same link "Copy Link" copies, opened directly (handy on the admin's own phone/PC to check or bookmark it).
            window.open(`${window.location.origin}${window.location.pathname}?staff=${id}`, '_blank', 'noopener');
        }

//@fn copyTextToClipboard
function copyTextToClipboard(text, successMsg) {
            if (!text) return;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(
                    () => showToast(successMsg || 'Copied.'),
                    () => window.prompt('Copy this link:', text)
                );
            } else {
                window.prompt('Copy this link:', text);
            }
        }

//@fn createBillNotification
function createBillNotification(type, bill) {
            const itemsTotal = (bill.items || []).reduce((sum, l) => sum + l.price * l.qty, 0);
            const balance = round2(Math.max(0, itemsTotal - (bill.amountPaid || 0)));
            const who = bill.customerName || 'a customer';
            const dueLabel = bill.dueDate ? formatShortDate(bill.dueDate) : '';
            const messages = {
                new_bill: `New bill recorded for ${who} — KES ${itemsTotal.toFixed(2)}${dueLabel ? `, due ${dueLabel}` : ''}.`,
                due_soon: `Bill for ${who} (KES ${balance.toFixed(2)}) is due ${dueLabel}.`,
                overdue: `Bill for ${who} (KES ${balance.toFixed(2)}) is overdue — was due ${dueLabel}.`,
                paid: `Bill for ${who} has been fully paid — KES ${itemsTotal.toFixed(2)}.`,
            };
            billNotifications.push({
                id: genSaleId(),
                type,
                billId: bill.id,
                customerName: who,
                amount: type === 'paid' ? itemsTotal : balance,
                dueDate: bill.dueDate || null,
                message: messages[type] || '',
                createdAt: new Date().toISOString(),
                recipientStaffIds: billNotifyStaffIds.slice(),
                readBy: [],
            });
            if (billNotifications.length > 300) billNotifications = billNotifications.slice(-300);
            safeSetItem('pos_bill_notifications', JSON.stringify(billNotifications));
            queuePush();
        }

//@fn csvEscape
function csvEscape(val) {
            const str = String(val === undefined || val === null ? '' : val);
            return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
        }

//@fn currentActiveTabId
function currentActiveTabId() {
            const active = document.querySelector('.tab-link.active[data-tab]');
            return active ? active.dataset.tab : (TAB_MASTER_ORDER[0] || null);
        }

//@fn currentAdminSettingsRestriction
function currentAdminSettingsRestriction() {
            if (!currentServer) return null;
            const member = staff.find(s => s.id === currentServer.id);
            if (!member || !Array.isArray(member.adminPermissions) || member.adminPermissions.length === 0) return null;
            return member.adminPermissions;
        }

//@fn currentNotifViewerId
function currentNotifViewerId() {
            return currentServer ? currentServer.id : '__owner__';
        }

//@fn currentPromoOfferTargets
function currentPromoOfferTargets() {
            return Array.from(document.querySelectorAll('#offer-target-picker [data-target-checkbox]:checked')).map(el => {
                return el.dataset.kind === 'category' ? { kind: 'category', category: el.dataset.value } : { kind: 'code', code: el.dataset.value };
            });
        }

//@fn currentStockValueTotals
function currentStockValueTotals() {
            const stocked = inventory.filter(p => (typeof isStockedProduct === 'function')
                ? isStockedProduct(p) : (p.type !== 'service'));
            return stockValueTotals(stocked.map(p => ({ code: p.code, closing: p.qty || 0 })));
        }

//@fn customerStatementPeriodLabel
function customerStatementPeriodLabel(preset) {
            if (preset === 'month1') return 'Last 1 Month';
            if (preset === 'month6') return 'Last 6 Months';
            return 'Full Statement';
        }

//@fn customerStatementPeriodRange
function customerStatementPeriodRange(preset) {
            if (preset === 'month1' || preset === 'month6') {
                const to = new Date();
                const from = new Date(to);
                from.setMonth(from.getMonth() - (preset === 'month1' ? 1 : 6));
                return { from, to };
            }
            return null; // full — no lower bound
        }

//@fn dataUrlToUint8Array
function dataUrlToUint8Array(dataUrl) {
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
        }

//@fn daysUntilExpiry
function daysUntilExpiry(expiryDate) {
            if (!expiryDate) return null;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const expiry = new Date(expiryDate + 'T00:00:00');
            if (isNaN(expiry.getTime())) return null;
            return Math.round((expiry - today) / 86400000);
        }

//@fn debtBalance
function debtBalance(d) { return Math.max(0, round2((d.amount || 0) - debtPaidSoFar(d))); }

//@fn debtPaidSoFar
function debtPaidSoFar(d) { return (d.payments || []).reduce((s, p) => s + (p.amount || 0), 0); }

//@fn decimalToFraction
function decimalToFraction(value) {
            const whole = Math.floor(value + 1e-9);
            const frac = value - whole;
            if (frac < 0.01) return whole.toString();

            const denominators = [2, 3, 4, 5, 8, 10, 16];
            let best = null;
            for (const den of denominators) {
                const num = Math.round(frac * den);
                if (num === 0 || num === den) continue;
                const err = Math.abs(frac - num / den);
                if (err < 0.02) { best = { num, den }; break; }
            }
            if (!best) return (Math.round(value * 100) / 100).toString();

            const gcd = (a, b) => b ? gcd(b, a % b) : a;
            const g = gcd(best.num, best.den);
            const fracStr = `${best.num / g}/${best.den / g}`;
            return whole > 0 ? `${whole} ${fracStr}` : fracStr;
        }

//@fn defaultDeviceName
function defaultDeviceName() {
            const ua = navigator.userAgent || '';
            if (/Android/i.test(ua)) return 'Android Device';
            if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS Device';
            if (/Windows/i.test(ua)) return 'Windows Desktop';
            if (/Macintosh/i.test(ua)) return 'Mac Desktop';
            return 'Device';
        }

//@fn deleteBarcode
function deleteBarcode(id) {
            savedBarcodes = savedBarcodes.filter(b => b.id !== id);
            safeSetItem('pos_barcodes', JSON.stringify(savedBarcodes));
            queuePush();
            renderSavedBarcodesTable();
            showToast('Barcode removed.');
        }

//@fn deleteBranch
async function deleteBranch(targetClientId, label) {
            if (!confirm(`Permanently delete "${label}"? Its link stops working immediately, its staff/sales/stock data is gone for good, and this can't be undone.`)) return;
            try {
                const res = await fetch(apiUrl('/api/branches'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'delete', targetClientId }),
                });
                const data = await res.json();
                if (!res.ok || data.error) {
                    showToast(data.error || 'Could not delete that branch.', true);
                    return;
                }
                showToast(`"${data.deletedLabel || label}" deleted.`);
                await renderBranchesPanel(true);
                if (typeof renderDashboardBranchesSection === 'function') renderDashboardBranchesSection();
            } catch (e) {
                showToast(netErrText('Could not reach the server'), true);
            }
        }

//@fn deleteInventoryItem
function deleteInventoryItem(code) {
            const product = inventory.find(p => p.code === code);
            if (!product) return;
            if (!confirm(`Remove "${product.name}" from inventory permanently?`)) return;

            inventory = inventory.filter(p => p.code !== code);
            safeSetItem('pos_inventory', JSON.stringify(inventory));
            queuePush();
            renderInventoryTable();
            renderNotifications();
            showToast(`Removed "${product.name}" from inventory.`);
        }

//@fn deletePrintRoutingRule
function deletePrintRoutingRule(idx) {
            if (!printRoutingRules[idx]) return;
            if (!confirm('Delete this routing rule?')) return;
            printRoutingRules.splice(idx, 1);
            persistPrintRoutingRules();
            renderPrintRoutingRulesList();
        }

//@fn deletePromoOffer
function deletePromoOffer(id) {
            const offer = offers.find(o => o.id === id);
            if (!offer) return;
            if (!confirm(`Delete the offer "${offer.name}"?`)) return;
            offers = offers.filter(o => o.id !== id);
            saveOffersLocal();
            queuePush();
            renderOffersList();
            if (inventoryEditModalCode) renderItemOffersList(inventoryEditModalCode);
            renderCart();
            showToast('Offer deleted.');
        }

//@fn deleteTradeCredit
function deleteTradeCredit(id) {
            if (!confirm('Remove this entry entirely? This is for correcting a mistake, not for settling a real debt — use "Mark Settled" for that.')) return;
            tradeCredits = tradeCredits.filter(t => t.id !== id);
            safeSetItem('pos_trade_credits', JSON.stringify(tradeCredits));
            queuePush();
            renderTradeCreditsTab();
        }

//@fn deleteWebAuthnCredential
async function deleteWebAuthnCredential(credentialId) {
            const db = await openWebAuthnDb();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(WEBAUTHN_STORE, 'readwrite');
                tx.objectStore(WEBAUTHN_STORE).delete(credentialId);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

//@fn detectOnceFromScanModal
async function detectOnceFromScanModal(video) {
            if (!scanModalStream || !video.videoWidth) return null;
            const w = scanModalCanvas.width = Math.min(video.videoWidth, 1280);
            const h = scanModalCanvas.height = Math.round(w * (video.videoHeight / video.videoWidth));
            const ctx = scanModalCanvasCtx;
            ctx.drawImage(video, 0, 0, w, h);

            const imageData = ctx.getImageData(0, 0, w, h);
            const d = imageData.data;
            const contrast = 1.35;
            const intercept = 128 * (1 - contrast);
            for (let i = 0; i < d.length; i += 4) {
                const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                const adjusted = Math.max(0, Math.min(255, gray * contrast + intercept));
                d[i] = d[i + 1] = d[i + 2] = adjusted;
            }
            ctx.putImageData(imageData, 0, 0);

            const barcodes = await scanModalDetector.detect(scanModalCanvas);
            return barcodes.length > 0 ? barcodes[0].rawValue : null;
        }

//@fn dismissCustomerDisplayDetectBanner
function dismissCustomerDisplayDetectBanner(use) {
            const banner = document.getElementById('cd-detect-banner');
            if (banner) banner.remove();
            if (use) openCustomerDisplayOnSecondScreen();
        }

//@fn dismissNotificationPromptBanner
function dismissNotificationPromptBanner(enable) {
            const banner = document.getElementById('notif-prompt-banner');
            if (banner) banner.remove();
            if (enable) enableStockNotifications();
        }

//@fn downloadBlob
function downloadBlob(blob, filename) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }

//@fn downloadReceiptPdf
async function downloadReceiptPdf() {
            const text = (lastReceiptText || '').trim();
            if (!text) { showToast('Nothing to download yet.', true); return; }
            try {
                const blob = await textToPdfBlob(text, { width: receiptImageWidthPx() });
                if (!blob) { showToast('Could not generate the receipt PDF.', true); return; }
                const ref = (currentReceiptSale && (currentReceiptSale.refNumber || currentReceiptSale.id)) || Date.now();
                downloadBlob(blob, `receipt-${ref}.pdf`);
            } catch (e) {
                // A canvas/PDF failure here used to leave the button doing
                // nothing with no sign anything went wrong — the sale itself
                // is already saved either way, only the PDF download failed.
                showToast('Could not generate the receipt PDF on this device — try printing instead.', true);
            }
        }

//@fn downloadReportPdf
async function downloadReportPdf() {
            const text = (lastReportText || '').trim();
            if (!text) { showToast('Nothing to download yet.', true); return; }
            try {
                const blob = await textToPdfBlob(text);
                if (!blob) { showToast('Could not generate the report PDF.', true); return; }
                downloadBlob(blob, `${reportFilenameBase()}.pdf`);
            } catch (e) {
                // Same as downloadReceiptPdf() above — a very long report on
                // a low-memory device could fail building the canvas/PDF;
                // this used to fail completely silently.
                showToast('Could not generate the report PDF on this device — try printing instead, or a shorter date range.', true);
            }
        }

//@fn endStaffShift
function endStaffShift(staffId) {
            const open = [...staffShifts].reverse().find(sh => sh.staffId === staffId && !sh.clockOut);
            if (!open) return;
            open.clockOut = Date.now();
            safeSetItem('pos_staff_shifts', JSON.stringify(staffShifts));
            queuePush();
        }

//@fn enrollAdminBiometric
function enrollAdminBiometric() {
            enrollBiometric('admin', null, businessName ? `${businessName} Owner` : 'Owner/Admin');
        }

//@fn enrollManagerBiometric
function enrollManagerBiometric() {
            const select = document.getElementById('biometric-manager-select');
            const manager = staff.find(s => s.id === select.value && s.isManager);
            if (!manager) { showToast('Select a manager first.', true); return; }
            enrollBiometric('manager', manager.id, manager.name);
        }

//@fn ensureSaleIds
function ensureSaleIds(list) {
            (list || []).forEach(s => {
                if (!s.id) s.id = `${new Date(s.timestamp).getTime() || Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                if (typeof s.paid !== 'boolean') s.paid = true;
            });
            return list;
        }

//@fn ensureViewedBranchLoaded
async function ensureViewedBranchLoaded() {
            if (viewedBranchId === 'self') return;
            if (!branchesSummaryCache) await fetchBranchesSummary();
            const members = (branchesSummaryCache && branchesSummaryCache.branches) || [];
            if (viewedBranchId === 'all') {
                await Promise.all(members.filter(b => !b.isSelf).map(b => fetchBranchDetail(b.id)));
            } else {
                await fetchBranchDetail(viewedBranchId);
            }
        }

//@fn escapeJsAttr
function escapeJsAttr(str) {
            return String(str)
                .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
                .replace(/\r/g, '\\r').replace(/\n/g, '\\n')
                .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
                .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

//@fn escapeQuotes
function escapeQuotes(str) {
            // LEGACY helper, kept for the id/key call sites where the same string is built
            // into markup AND looked up again in JS. For new code prefer escapeJsAttr()
            // (a value inside onclick="fn('...')") or escapeHtml() (an attribute value).
            // Also neutralises backslashes, double quotes and newlines - the old version
            // only handled ', so a crafted name could break out of the handler/attribute.
            // zip 143: & < > are HTML-escaped too — "&#39;" in a name was turned back into ' by the browser inside onclick="…" and
            // closed the string; and a few call sites put the result in text (an <option>), where < was not escaped.
            return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
                .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/\r/g, '\\r').replace(/\n/g, '\\n');
        }

//@fn estimateLicenseOffline
function estimateLicenseOffline() {
            let checkpoint;
            try {
                checkpoint = safeJSONParse('pos_license_checkpoint', null);
            } catch (e) {
                checkpoint = null;
            }
            if (!checkpoint) return null; // never successfully checked even once — nothing to estimate from

            if (checkpoint.type === 'permanent') {
                return { valid: checkpoint.valid, reason: checkpoint.reason, type: 'permanent', clientId: myClientId, offlineEstimate: true };
            }

            const now = Date.now();
            if (now < checkpoint.checkedAtLocal) {
                // Clock moved backward since the last real server check — cannot be
                // trusted. Fail closed rather than silently extending the trial.
                return { valid: false, reason: 'clock_tampered', type: 'demo', offlineEstimate: true };
            }

            const elapsed = now - checkpoint.checkedAtLocal;
            const estimatedRemaining = (checkpoint.remainingMs || 0) - elapsed;
            if (estimatedRemaining <= 0) {
                return { valid: false, reason: 'expired', type: 'demo', offlineEstimate: true };
            }
            return { valid: true, reason: 'demo_active', type: 'demo', remainingMs: estimatedRemaining, offlineEstimate: true };
        }

//@fn etimsLogPeriodLabel
function etimsLogPeriodLabel(range) {
            const fmt = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            return range.from === range.to ? fmt(range.from) : `${fmt(range.from)} — ${fmt(range.to)}`;
        }

//@fn expectedTimesForPersonKey
function expectedTimesForPersonKey(personKey) {
            if (!personKey) return { clockIn: null, clockOut: null };
            const [kind, id] = personKey.split(':');
            const person = kind === 'staff' ? staff.find(s => s.id === id) : attendanceRoster.find(r => r.id === id);
            if (!person) return { clockIn: null, clockOut: null };
            return { clockIn: person.expectedClockIn || null, clockOut: person.expectedClockOut || null };
        }

//@fn extractNumber
function extractNumber(raw) {
            const cleaned = String(raw || '').replace(/[^0-9.\-]/g, '');
            const n = parseFloat(cleaned);
            return Number.isFinite(n) ? n : 0;
        }

//@fn fetchAndAttachLookupImage
async function fetchAndAttachLookupImage(imageUrl) {
            try {
                const proxyRes = await fetch(apiUrl(`/api/image-proxy?url=${encodeURIComponent(imageUrl)}`));
                if (!proxyRes.ok) return;
                const blob = await proxyRes.blob();
                const dataUrl = await readImageAsProductJpeg(blob);
                currentCapturedImageBase64 = dataUrl;
                const previewEl = document.getElementById('photo-preview-element');
                if (previewEl) previewEl.src = dataUrl;
                showToast('Product photo attached too — check it before saving.');
            } catch (e) {
                // Silent — see comment above.
            }
        }

//@fn fetchBranchDetail
async function fetchBranchDetail(clientId, forceRefresh) {
            if (!forceRefresh && branchDetailCache[clientId]) return branchDetailCache[clientId];
            try {
                const res = await fetch(apiUrl('/api/branches'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'detail', targetClientId: clientId }),
                });
                const data = await res.json();
                if (!res.ok || data.error) return null;
                branchDetailCache[clientId] = data.state || {};
                return branchDetailCache[clientId];
            } catch (e) {
                return null;
            }
        }

//@fn fetchBranchesSummary
async function fetchBranchesSummary(forceRefresh) {
            if (!forceRefresh && branchesSummaryCache) return branchesSummaryCache;
            try {
                const res = await fetch(apiUrl('/api/branches'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'summary' }),
                });
                const data = await res.json();
                if (!res.ok || data.error) return null;
                branchesSummaryCache = data;
                return data;
            } catch (e) {
                return null;
            }
        }

//@fn fetchPaymentAccounts
async function fetchPaymentAccounts() {
            try {
                const res = await fetch(apiUrl('/api/payment-accounts'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'get' }),
                });
                const data = await res.json();
                if (res.ok && Array.isArray(data.accounts)) {
                    paymentAccounts = data.accounts;
                    renderReceivingAccountSelector();
                    renderReportAccountFilter();
                    if (document.getElementById('payment-accounts-list')) renderPaymentAccountsListView();
                }
            } catch (e) {
                // Keep whatever was last cached — a failed refresh shouldn't
                // clear the account list out from under an in-progress sale.
            }
            return paymentAccounts;
        }

//@fn fetchReceiptSettingsSharing
async function fetchReceiptSettingsSharing() {
            const wrap = document.getElementById('receipt-settings-branch-sharing');
            if (!myBranchGroupId) {
                if (wrap) wrap.style.display = 'none';
                return;
            }
            if (wrap) wrap.style.display = 'block';
            try {
                const res = await fetch(apiUrl('/api/receipt-settings'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'get' }),
                });
                const data = await res.json();
                if (!res.ok) return;
                receiptSettingsUseShared = !!data.useShared;
                const toggle = document.getElementById('receipt-settings-shared-toggle');
                if (toggle) {
                    toggle.checked = receiptSettingsUseShared;
                    toggle.disabled = !myIsMainBranch;
                }
                const nonMainNote = document.getElementById('receipt-settings-managed-note');
                const editableWrap = document.getElementById('receipt-settings-editable-area');
                const isReadOnlyHere = receiptSettingsUseShared && !myIsMainBranch;
                if (nonMainNote) nonMainNote.style.display = isReadOnlyHere ? 'block' : 'none';
                if (editableWrap) editableWrap.style.opacity = isReadOnlyHere ? '0.5' : '1';
                document.querySelectorAll('#settings-section-receipts input, #settings-section-receipts textarea, #settings-section-receipts select, #settings-section-receipts button:not(#receipt-settings-shared-toggle)').forEach(el => {
                    if (el.id !== 'receipt-settings-shared-toggle') el.disabled = isReadOnlyHere;
                });

                if (receiptSettingsUseShared && data.settings) {
                    applyReceiptSettingsSnapshot(data.settings);
                }
            } catch (e) {
                // Keep using whatever's cached locally — a failed refresh
                // shouldn't stop receipts from printing.
            }
        }

//@fn fetchSmsOptOutCount
async function fetchSmsOptOutCount() {
            const el = document.getElementById('sms-optout-count');
            if (!el) return;
            try {
                const res = await fetch(apiUrl('/api/sms-inbound'));
                const data = await res.json();
                const count = (data.optOuts || []).length;
                el.textContent = count === 0
                    ? 'Nobody has opted out yet.'
                    : `${count} customer${count === 1 ? ' has' : 's have'} opted out and won’t receive any SMS from this shop.`;
            } catch (e) {
                el.textContent = '';
            }
        }

//@fn fileExt
function fileExt(filename) {
            const m = /\.([a-z0-9]+)$/i.exec(filename || '');
            return m ? m[1].toLowerCase() : '';
        }

//@fn fillSmsTemplate
function fillSmsTemplate(template, vars) {
            return template
                .replace(/\{name\}/g, vars.name || 'valued customer')
                .replace(/\{amount\}/g, vars.amount != null ? Number(vars.amount).toFixed(2) : '')
                .replace(/\{business\}/g, vars.business || (businessName || 'us'));
        }

//@fn findCsvColumn
function findCsvColumn(lowerHeaderRow, aliases) {
            for (const alias of aliases) {
                const at = lowerHeaderRow.indexOf(alias.trim().toLowerCase());
                if (at !== -1) return at;
            }
            return -1;
        }

//@fn findDeliveryAgentById
function findDeliveryAgentById(agentId) {
            return getAllDeliveryAgents().find(a => a.id === agentId) || null;
        }

//@fn findDeliveryRecord
function findDeliveryRecord(saleId, source) {
            const arr = source === 'bills' ? bills : salesLog;
            return arr.find(r => r.id === saleId);
        }

//@fn findInventoryByName
function findInventoryByName(name) {
            if (!name) return null;
            const n = name.trim().toLowerCase();
            return inventory.find(p => (p.name || '').trim().toLowerCase() === n) || null;
        }

//@fn findSaleForVoid
function findSaleForVoid(saleId, source) {
            const list = source === 'bills' ? bills : salesLog;
            return list.find(s => s.id === saleId) || null;
        }

//@fn flagWithinImportIngredientDuplicates
function flagWithinImportIngredientDuplicates() {
            const seenNames = new Set();
            recipeCaptureState.dishes.forEach(dish => {
                dish.ingredients.forEach(row => {
                    if (row.matchedCode) return; // matched to a real, already-existing item — nothing to flag
                    const key = row.name.trim().toLowerCase();
                    if (!key) return;
                    row.dupWithinImport = seenNames.has(key);
                    seenNames.add(key);
                });
            });
        }

//@fn focusContractField
function focusContractField(rowId, field) {
            const index = contractDraft.findIndex(r => r.rowId === rowId);
            if (index < 0) return;
            const colIndex = { name: 0, qty: 1, price: 2 }[field];
            if (colIndex === undefined) return;
            const tbody = document.getElementById('contract-rows-tbody');
            if (!tbody) return;
            const rowEl = tbody.children[index];
            if (!rowEl) return;
            const input = rowEl.children[colIndex] && rowEl.children[colIndex].querySelector('input');
            if (input) {
                input.focus();
                input.select();
            }
        }

//@fn formatFileSize
function formatFileSize(bytes) {
            return bytes >= 1024 * 1024
                ? (bytes / (1024 * 1024)).toFixed(1) + 'MB'
                : Math.max(1, Math.round(bytes / 1024)) + 'KB';
        }

//@fn formatHours
function formatHours(hoursDecimal) {
            const h = Math.floor(hoursDecimal);
            const m = Math.round((hoursDecimal - h) * 60);
            if (h === 0 && m === 0) return '0m';
            return `${h > 0 ? h + 'h ' : ''}${m}m`;
        }

//@fn formatPickedPhone
function formatPickedPhone(raw) {
            let p = (raw || '').trim();
            const digits = p.replace(/\D/g, '');
            if (digits.startsWith('254') && digits.length === 12) return '0' + digits.slice(3);
            if (digits.startsWith('0') && digits.length === 10) return digits;
            return p;
        }

//@fn formatQty
function formatQty(qty, unit) {
            const n = Number(qty) || 0;
            if (!isDecimalUnit(unit)) {
                return Math.round(n).toString();
            }
            return (Math.round(n * 100) / 100).toString();
        }

//@fn formatQtyDisplay
function formatQtyDisplay(qty, unit) {
            const n = Number(qty) || 0;
            if (!isDecimalUnit(unit)) return Math.round(n).toString();
            if (qtyDisplayFormat === 'fraction') return decimalToFraction(n);
            return (Math.round(n * 100) / 100).toString();
        }

//@fn formatRemaining
function formatRemaining(ms) {
            const total = Math.max(0, Math.floor(ms / 60000));
            const h = Math.floor(total / 60);
            const m = total % 60;
            return h > 0 ? `${h}h ${m}m` : `${m}m`;
        }

//@fn formatShiftTime
function formatShiftTime(ms) {
            return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        }

//@fn formatShortDate
function formatShortDate(dateStr) {
            if (!dateStr) return '?';
            const d = new Date(dateStr + 'T00:00:00');
            if (isNaN(d.getTime())) return dateStr;
            const pad = (n) => String(n).padStart(2, '0');
            return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`;
        }

//@fn fuzzyMatchInventory
function fuzzyMatchInventory(name, pool) {
            const norm = normalizeForMatch(name);
            if (!norm) return { item: null, score: 0 };
            let best = null, bestScore = 0;
            pool.forEach(p => {
                const pn = normalizeForMatch(p.name);
                if (!pn) return;
                const dist = levenshteinDistance(norm, pn);
                const maxLen = Math.max(norm.length, pn.length) || 1;
                let score = 1 - dist / maxLen;
                if (pn.includes(norm) || norm.includes(pn)) score = Math.max(score, 0.82);
                if (score > bestScore) { bestScore = score; best = p; }
            });
            return { item: best, score: bestScore };
        }

//@fn genGasCode
function genGasCode(prefix) {
            return `${prefix}-${genSaleId()}`;
        }

//@fn addGasLineToCart
function addGasLineToCart() {
            // Four ways to sell gas cylinders. Every one is an ordinary line in the Sales Counter cart; the stock moves when the sale is made:
            //   exchange — full -1, empty +1 (the customer hands in an empty)      outright — full -1 (a full cylinder with gas, theirs to keep)
            //   set      — full -1 plus the accessories ticked                     empty    — empty -1 (an empty cylinder on its own)
            const msgEl = document.getElementById('gas-add-msg');
            const fail = (m) => { msgEl.className = 'settings-msg error'; msgEl.textContent = m; };
            const full = inventory.find(p => p.code === window.__gasSel);
            const qty = Math.max(1, Math.round(parseFloat(document.getElementById('gas-tx-qty').value) || 1));
            if (!full) { fail('Pick a cylinder size first.'); return; }
            const empty = inventory.find(p => p.code === full.gasPairCode);
            const label = gasLabelOf(full);
            const type = gasTxType;
            const needEmpty = type === 'empty';
            const item = needEmpty ? empty : full;
            const suffix = { exchange: 'gasrefill', outright: 'gasoutright', set: 'gasset', empty: 'gasempty' }[type] || 'gasrefill';
            const key = `${item.code}::${suffix}`;
            const existing = currentCart[key] ? currentCart[key].qty : 0;
            const available = item.qty || 0;
            if (existing + qty > available) { fail(`Only ${available} ${needEmpty ? 'empty' : 'full'} "${label}" in stock.`); return; }
            const price = type === 'exchange' ? (full.gasRefillPrice || 0) : (needEmpty ? (empty.price || 0) : (full.price || 0));
            if (!(price > 0)) { fail(`Set the ${type === 'exchange' ? 'refill' : (needEmpty ? 'empty cylinder' : 'full cylinder')} price for ${label} in the table above first.`); return; }
            const names = { exchange: 'Refill/Exchange', outright: 'Full Cylinder', set: 'Complete Set', empty: 'Empty Cylinder' };
            currentCart[key] = currentCart[key]
                ? { ...currentCart[key], qty: existing + qty }
                : {
                    code: item.code, cartKey: key, name: `${label} — ${names[type]}`, price,
                    wholesalePrice: type === 'exchange' ? (full.gasRefillWholesalePrice || 0) : (needEmpty ? 0 : (full.wholesaleSellingPrice || 0)),
                    unit: 'pcs', isService: false, vatCategory: item.vatCategory || 'A', qty,
                    ...(type === 'exchange' ? { gasReturnEmptyCode: full.gasPairCode } : {}),
                };
            if (type === 'set') {
                document.querySelectorAll('#gas-set-accessories-list .gas-acc-row').forEach(row => {
                    if (!row.querySelector('.gas-acc-check').checked) return;
                    const per = Math.max(1, Math.round(parseFloat(row.querySelector('.gas-acc-qty').value) || 1));
                    for (let i = 0; i < per * qty; i++) addToCart(row.dataset.code);
                });
            }
            renderCart();
            msgEl.className = 'settings-msg success';
            msgEl.textContent = `Added ${qty} × ${label} — ${names[type]} to the sale. Go to 🛒 Sales Counter to take payment.`;
            renderGasVariantStock();
        }

//@fn unmarkGasAccessory
function unmarkGasAccessory(code) {
            const p = inventory.find(x => x.code === code);
            if (!p) return;
            delete p.isGasAccessory;
            gasSaveInventory();
        }

//@fn markGasAccessory
function markGasAccessory() {
            const sel = document.getElementById('gas-accessory-pick');
            const p = inventory.find(x => x.code === (sel && sel.value));
            if (!p) { showToast('Pick an item to mark as an accessory.', true); return; }
            p.isGasAccessory = true;
            if (!p.gasAccessoryType) p.gasAccessoryType = 'other';
            gasSaveInventory();
        }

//@fn selectGasSize
function selectGasSize(code) {
            window.__gasSel = code;
            renderGasTab();
        }

//@fn addGasSize
function addGasSize() {
            const msgEl = document.getElementById('gas-size-msg');
            const size = (document.getElementById('gas-new-size').value || '').trim();
            const brand = (document.getElementById('gas-new-brand').value || '').trim();
            const fullStock = Math.max(0, Math.round(parseFloat(document.getElementById('gas-new-full-stock').value) || 0));
            const emptyStock = Math.max(0, Math.round(parseFloat(document.getElementById('gas-new-empty-stock').value) || 0));
            const fail = (m) => { msgEl.className = 'settings-msg error'; msgEl.textContent = m; };
            if (!size) { fail('Type the size, for example 13kg or 6kg.'); return; }
            const label = `${brand ? brand + ' ' : ''}${size}`;
            if (getGasFullVariants().some(f => gasLabelOf(f).toLowerCase() === label.toLowerCase())) { fail(`"${label}" is already in the list — change its numbers in the table.`); return; }
            const fullCode = genGasCode('GASF'), emptyCode = genGasCode('GASE');
            // Two ordinary inventory items per size (they show in Inventory and can be sold at the Sales Counter like anything else).
            inventory.push({
                code: fullCode, type: 'item', name: `${label} (Full)`, price: 0, wholesaleSellingPrice: 0, wholesalePrice: 0, qty: fullStock, unit: 'pcs', vatCategory: 'A',
                isGasCylinder: true, gasRole: 'full', gasBrand: brand, gasWeight: size, gasPairCode: emptyCode, gasRefillPrice: 0, gasRefillWholesalePrice: 0,
            });
            inventory.push({
                code: emptyCode, type: 'item', name: `${label} (Empty)`, price: 0, wholesaleSellingPrice: 0, wholesalePrice: 0, qty: emptyStock, unit: 'pcs', vatCategory: 'A',
                isGasCylinder: true, gasRole: 'empty', gasBrand: brand, gasWeight: size, gasPairCode: fullCode,
            });
            ['gas-new-size', 'gas-new-brand'].forEach(id => { document.getElementById(id).value = ''; });
            document.getElementById('gas-new-full-stock').value = '0';
            document.getElementById('gas-new-empty-stock').value = '0';
            window.__gasSel = fullCode;
            gasSaveInventory();
            msgEl.className = 'settings-msg success';
            msgEl.textContent = `Added ${label}: ${fullStock} full, ${emptyStock} empty. Now set its prices in the table.`;
        }

//@fn gasBoardPrice
function gasBoardPrice(code, field, value) {
            const full = inventory.find(p => p.code === code);
            if (!full) return;
            const n = parseFloat(value);
            if (!(n >= 0)) { showToast('Enter a price, 0 or more.', true); renderGasTab(); return; }
            if (field === 'refill') full.gasRefillPrice = n;
            else if (field === 'empty') { const e = inventory.find(p => p.code === full.gasPairCode); if (e) e.price = n; }
            else full.price = n;
            gasSaveInventory();
        }

//@fn gasBoardSet
function gasBoardSet(code, which, value) {
            // A stock count typed straight into the board: "Full 13kg = 20", "Empty 13kg = 5".
            const full = inventory.find(p => p.code === code);
            if (!full) return;
            const item = which === 'empty' ? inventory.find(p => p.code === full.gasPairCode) : full;
            const n = Math.round(parseFloat(value));
            if (!item || !(n >= 0)) { showToast('Enter a whole number, 0 or more.', true); renderGasTab(); return; }
            const delta = n - (item.qty || 0);
            item.qty = n;
            if (delta && typeof logStockMovement === 'function') logStockMovement(item.code, item.name, delta, 'Gas stock count');
            gasSaveInventory();
        }

//@fn gasSaveInventory
function gasSaveInventory() {
            safeSetItem('pos_inventory', JSON.stringify(inventory));
            queuePush();
            renderGasTab();
            if (typeof renderInventoryTable === 'function') renderInventoryTable();
        }

//@fn gasTotals
function gasTotals() {
            // Cylinders by state, across every size: Full, Empty, and Away (empties sent to the supplier and not back yet).
            let full = 0, empty = 0, away = 0;
            getGasFullVariants().forEach(f => {
                full += f.qty || 0;
                const e = inventory.find(p => p.code === f.gasPairCode);
                empty += (e && e.qty) || 0;
                away += f.gasAtSupplier || 0;
            });
            return { full, empty, away, total: full + empty + away };
        }

//@fn gasLabelOf
function gasLabelOf(full) {
            return `${full.gasBrand ? full.gasBrand + ' ' : ''}${full.gasWeight || ''}`.trim();
        }

//@fn generateItemCode
function generateItemCode() {
            const existingCodes = new Set(inventory.map(p => (p.code || '').toLowerCase()));
            const numericCodes = inventory
                .map(p => p.code)
                .filter(c => /^\d+$/.test(c))
                .map(c => parseInt(c, 10));
            let next = (numericCodes.length ? Math.max(...numericCodes) : 0) + 1;
            let candidate = String(next).padStart(5, '0');
            while (existingCodes.has(candidate.toLowerCase())) {
                next += 1;
                candidate = String(next).padStart(5, '0');
            }
            return candidate;
        }

//@fn generateToken
function generateToken() {
            if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
            return 'xxxxxxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
        }

//@fn getAllDeliveryAgents
function getAllDeliveryAgents() {
            const internal = staff
                .filter(s => Array.isArray(s.roles) && s.roles.includes('deliveries-tab'))
                .map(s => ({ id: `staff:${s.id}`, staffId: s.id, name: s.name, phone: s.phone || '', type: 'internal' }));
            const external = deliveryAgents.map(a => ({ id: `ext:${a.id}`, staffId: null, name: a.name, phone: a.phone || '', type: 'external', extId: a.id }));
            return [...internal, ...external];
        }

//@fn getAssignedDeliveryOrders
function getAssignedDeliveryOrders() {
            const fromSales = salesLog.filter(s => s.orderType === 'delivery' && s.deliveryAgentId).map(s => ({ record: s, source: 'salesLog' }));
            const fromBills = bills.filter(b => b.orderType === 'delivery' && b.deliveryAgentId).map(b => ({ record: b, source: 'bills' }));
            return [...fromSales, ...fromBills].sort((a, b) => new Date(b.record.timestamp) - new Date(a.record.timestamp));
        }

//@fn getCurrentActiveTabId
function getCurrentActiveTabId() {
            const active = document.querySelector('.tab-content.active');
            return active ? active.id : null;
        }

//@fn getCustomerStatementSales
function getCustomerStatementSales(customer, preset) {
            const range = customerStatementPeriodRange(preset);
            let matching = salesLog.filter(s => !s.voided && (s.customerPhone === customer.phone || s.mpesaPhone === customer.phone));
            if (range) {
                matching = matching.filter(s => {
                    const t = new Date(s.timestamp);
                    return t >= range.from && t <= range.to;
                });
            }
            return matching;
        }

//@fn getEffectivePrice
function getEffectivePrice(product, mode) {
            if (mode === 'piece') return product.piecePrice || 0;
            // Always a number: an item that was saved without a price (an import, an older record) used to make every place that shows its
            // price throw "Cannot read properties of undefined (reading 'toFixed')".
            const base = Number(product.price) || 0;
            if (!isOfferActive(product)) return base;
            return product.offer.type === 'fixed'
                ? (Number(product.offer.value) || 0)
                : Math.max(0, base * (1 - (Number(product.offer.value) || 0) / 100));
        }

//@fn getExchangeNetPayable
function getExchangeNetPayable() {
            const creditValue = parseFloat(document.getElementById('exchange-credit-value-input').value) || 0;
            return getExchangeReplacementTotal() - creditValue;
        }

//@fn getExchangeReplacementTotal
function getExchangeReplacementTotal() {
            return exchangeReplacementItems.reduce((sum, l) => sum + l.price * l.qty, 0);
        }

//@fn getExpiringItems
function getExpiringItems() {
            return inventory
                .filter(p => (p.type || 'item') !== 'service' && p.expiryDate)
                .map(p => ({ ...p, daysLeft: daysUntilExpiry(p.expiryDate) }))
                .filter(p => p.daysLeft !== null && p.daysLeft <= EXPIRY_WARNING_DAYS)
                .sort((a, b) => a.daysLeft - b.daysLeft);
        }

//@fn getFaultyReturns
function getFaultyReturns() {
            return returns.filter(r => r.condition === 'damaged');
        }

//@fn getGasAccessories
function getGasAccessories(type) {
            return inventory.filter(p => p.isGasAccessory && (!type || p.gasAccessoryType === type));
        }

//@fn getGasFullVariants
function getGasFullVariants() {
            return inventory.filter(p => p.isGasCylinder && p.gasRole === 'full');
        }

//@fn getLocState
function getLocState(kind, label) {
            const map = kind === 'table' ? tableStates : roomStates;
            return map[label] || { status: 'available', reservation: null };
        }

//@fn getLowStockRecipeServices
function getLowStockRecipeServices() {
            return inventory
                .filter(p => p.type === 'service' && p.recipe && p.recipe.length && getServiceAvailableQty(p) <= LOW_STOCK_THRESHOLD)
                .map(p => ({ code: p.code, name: p.name, location: '', qty: getServiceAvailableQty(p), unit: p.unit || 'use' }));
        }

//@fn getOrCreateDeviceId
function getOrCreateDeviceId() {
            let id = localStorage.getItem('pos_device_id');
            if (!id) {
                id = 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                safeSetItem('pos_device_id', id);
            }
            return id;
        }

//@fn returnQtyGuard
// A receipt can only be refunded / exchanged up to what it actually sold (zip 119). Before, nothing stopped the same receipt line
// being returned twice — on two tills, or twice by mistake — paying out or restocking more than was ever sold. Counts every return
// and exchange already recorded against that receipt for that item (synced from every till). Returns true when `qty` may go ahead;
// otherwise shows why in `errEl` and returns false. Items not picked from a receipt (free search) are not limited.
function returnQtyGuard(item, qty, errEl) {
            if (!item || !item.sourceRefNumber || !item.code) return true;
            const ref = String(item.sourceRefNumber);
            const sale = (typeof salesLog !== 'undefined' && Array.isArray(salesLog) ? salesLog : []).find((x) => x && x.refNumber === ref);
            if (!sale) return true;
            const say = (t) => { if (errEl) errEl.textContent = t; else if (typeof showToast === 'function') showToast(t, true); return false; };
            if (sale.voided) return say(`${ref} was voided — there is nothing left to return on it.`);
            const sold = (sale.items || []).filter((l) => l && l.code === item.code).reduce((t, l) => t + (Number(l.qty) || 0), 0);
            const returned = (typeof returns !== 'undefined' && Array.isArray(returns) ? returns : [])
                .filter((r) => r && !r._deleted && r.refNumber === ref && r.itemCode === item.code)
                .reduce((t, r) => t + (Number(r.qty) || 0), 0);
            const left = Math.round((sold - returned) * 1000) / 1000;
            if (qty > left + 1e-9) return say(left > 0 ? `Only ${left} of "${item.name}" can still be returned on ${ref} (${returned} already returned).` : `"${item.name}" on ${ref} has already been fully returned.`);
            return true;
        }

//@fn saleCtxNow
// Who / where a sale is being made (zip 119, Phase 5): till number, device, station, cashier, shift, business. Captured when the
// receipt reference is issued (see generateReceiptRef) and attached to that sale when it is sent (stampLocalContext).
function saleCtxNow() {
            let station = '';
            try { station = localStorage.getItem('pos_device_station') || localStorage.getItem('pos_print_station') || ''; } catch (e) { /* optional */ }
            const cashierId = (typeof currentServer !== 'undefined' && currentServer && currentServer.id) ? currentServer.id : 'admin';
            let shiftId = '';
            try {
                const list = typeof staffShifts !== 'undefined' && Array.isArray(staffShifts) ? staffShifts : [];
                const sid = cashierId === 'admin' ? (typeof ADMIN_SHIFT_ID !== 'undefined' ? ADMIN_SHIFT_ID : 'admin') : cashierId;
                const open = list.filter((x) => x && x.staffId === sid && !x.clockOut).sort((a, b) => (b.clockIn || 0) - (a.clockIn || 0))[0];
                if (open) shiftId = open.id;
                if (!shiftId && typeof cashShifts !== 'undefined' && Array.isArray(cashShifts)) {
                    const me = typeof activeServerName === 'function' ? activeServerName() : '';
                    const cs = cashShifts.find((x) => x && x.status === 'open' && x.cashier === me);
                    if (cs) shiftId = cs.id;
                }
            } catch (e) { /* no shift */ }
            return {
                till: tillNumber() || null, device: getOrCreateDeviceId(), station: station || null,
                cashier: typeof activeServerName === 'function' ? activeServerName() : '', cashierId, shiftId: shiftId || null,
                branch: (typeof businessName !== 'undefined' && businessName) || null, host: (typeof location !== 'undefined' && location.host) || null,
            };
        }

//@fn stampLocalContext
// Called on every push (from slimPayloadForPush): sales whose reference THIS device issued get the context captured then (never
// a guess — records from other devices are left alone), and this device's stock movements still waiting for the server get the
// device / till / station they came from and a count of how many times they have been sent (the server applies each once anyway).
function stampLocalContext(payload) {
            try {
                let issued = {};
                try { issued = JSON.parse(localStorage.getItem('pos_ref_ctx_v1') || '{}') || {}; } catch (e) { issued = {}; }
                if (Array.isArray(payload.salesLog) && Object.keys(issued).length) {
                    payload.salesLog.forEach((x) => { if (x && !x.ctx && x.refNumber && issued[x.refNumber]) x.ctx = issued[x.refNumber]; });
                }
                if (Array.isArray(payload.stockMovementLog)) {
                    const dev = getOrCreateDeviceId(), till = tillNumber() || null;
                    let station = null;
                    try { station = localStorage.getItem('pos_device_station') || null; } catch (e) { /* optional */ }
                    payload.stockMovementLog.forEach((m) => {
                        if (!m || !m.lg || m._srv) return;
                        if (!m.dev) { m.dev = dev; m.till = till; if (station) m.stn = station; }
                        m.tries = (Number(m.tries) || 0) + 1;
                    });
                }
            } catch (e) { /* never block a push */ }
        }

//@fn syncJournal
// A short on-device record of the sync itself (Phase 12): each send, each failed send (and why), each retry after a failure, and
// every stock conflict the server resolved for this device (a count superseded by a later one, a count made against an old
// figure). Kept apart from business events so a retry is never mistaken for a second sale or stock change. Last 300 entries.
function syncJournal(kind, detail) {
            try {
                const key = 'pos_sync_journal_v1';
                const list = JSON.parse(localStorage.getItem(key) || '[]');
                list.unshift({ at: Date.now(), kind, detail: String(detail || '').slice(0, 300), by: typeof activeServerName === 'function' ? activeServerName() : '' });
                localStorage.setItem(key, JSON.stringify(list.slice(0, 300)));
            } catch (e) { /* diagnostics only */ }
        }

//@fn syncJournalAuditEvents
// The Audit tab's "Sync" events (zip 127): only what went RIGHT and matters to the business — one line per batch of new sales /
// stock changes / returns / expenses that reached the server (a retry never adds a second line: each record is announced once, when it
// first reaches the server), sales recovered from this device's journal, "Sync to this device", and stock conflicts the server
// resolved. A failed send, a busy server, a timeout or a retry is NOT a business event: it stays in the technical sync journal
// (Settings ▸ Devices & Security ▸ Sync diagnostics) and the data stays queued on the device until it goes through.
function syncJournalAuditEvents() {
            const out = [];
            let ok = [];
            try { ok = JSON.parse(localStorage.getItem('pos_sync_audit_v1') || '[]'); } catch (e) { ok = []; }
            (window.__syncAuditMem || []).forEach((m) => { if (!m.saved) ok.push(m); });       // not stored (device full): still shown
            ok.forEach((e) => {
                if (!e || !e.at) return;
                out.push({ at: e.at, user: e.by || 'Device', module: 'Sync', action: e.kind === 'recovered' ? 'Sales recovered on this device' : /^Synced to this device/.test(e.what || '') ? 'Synced to this device' : 'Synced to the server',
                    detail: (e.what || '') + (e.refs && e.refs.length ? ' — ' + e.refs.join(', ') : ''), ref: '' });
            });
            let list = [];
            try { list = JSON.parse(localStorage.getItem('pos_sync_journal_v1') || '[]'); } catch (e) { list = []; }
            list.forEach((e) => { if (e && e.kind === 'conflict') out.push({ at: e.at, user: e.by || 'Device', module: 'Sync', action: 'Sync: stock conflict resolved by the server', detail: e.detail || '', ref: '' }); });
            return out;
        }

//@fn syncJournalConflicts
// Stock conflicts in a pulled payload that concern THIS device's own movements, journaled once each.
function syncJournalConflicts(pulledLog) {
            try {
                if (!Array.isArray(pulledLog)) return;
                const dev = getOrCreateDeviceId();
                let seen = [];
                try { seen = JSON.parse(localStorage.getItem('pos_sync_conflicts_seen_v1') || '[]'); } catch (e) { seen = []; }
                const seenSet = new Set(seen);
                pulledLog.forEach((m) => {
                    if (!m || m.dev !== dev || !m._srv || seenSet.has(String(m.id))) return;
                    if (m._srv.applied === false && m._srv.reason !== 'initial') {
                        syncJournal('conflict', `${m.name || m.code || 'item'}: ${m.kind === 'count' ? 'count' : 'change'} not applied (${m._srv.reason === 'older-count' ? 'a later stock take was already recorded' : m._srv.reason === 'before-count' ? 'already covered by a later stock take' : m._srv.reason})`);
                    } else if (m._srv.stale) {
                        syncJournal('conflict', `${m.name || m.code || 'item'}: counted against an out-of-date figure (${m._srv.before} on the server) — the physical count was applied`);
                    } else return;
                    seenSet.add(String(m.id));
                });
                localStorage.setItem('pos_sync_conflicts_seen_v1', JSON.stringify(Array.from(seenSet).slice(-2000)));
            } catch (e) { /* diagnostics only */ }
        }

//@fn saleCtxText
function saleCtxText(sale) {
            const c = sale && sale.ctx;
            if (!c) return '';
            return [c.till ? 'till ' + c.till : '', c.station ? 'station ' + c.station : '', c.shiftId ? 'shift ' + String(c.shiftId).slice(-6) : ''].filter(Boolean).join(' · ');
        }

//@fn pbkdf2Hex
async function pbkdf2Hex(secret, salt, iterations) {
            const enc = new TextEncoder();
            const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), 'PBKDF2', false, ['deriveBits']);
            const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(String(salt)), iterations }, key, 256);
            return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
        }

//@fn hashSalt
// The shop's salt for sealHash: derived from the shop link, so every device of one shop seals a given password / PIN to the SAME value
// (no ping-pong between devices, "Stay signed in" and duplicate-staff detection keep working) while two shops never share a salt.
async function hashSalt() {
            let key = '';
            try { key = (typeof clientToken !== 'undefined' && clientToken) || ''; } catch (e) { /* not declared yet */ }
            key = key || location.host || 'mydukapos';
            const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('mydukapos-salt:' + key));
            return Array.from(new Uint8Array(d)).slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
        }

//@fn sealHash
// SALTED, SLOW PASSWORD / PIN HASHES (zip 121). A stored hash used to be a plain SHA-256 of the password — copied to every device (so
// signing in works offline), and a short password could be recovered from it with a precomputed table in an instant. It is now stored as
// "p2$<iterations>$<salt>$<PBKDF2-SHA256(old hash, salt)>": a per-shop salt and 100,000 rounds, so every guess costs 100,000x more and
// nothing can be precomputed across shops. Because it is built FROM the old hash, existing hashes are upgraded without anyone re-typing a
// password (sealStoredHashes), and hashMatches() accepts both forms — nobody can be locked out by the change. It also means a device that
// was revoked can no longer re-pair with the hash it holds: pairing needs the password itself (functions/api/device-pair.js).
// Without Web Crypto (a non-HTTPS page) the old form is kept, and still works.
async function sealHash(sha) {
            if (!sha || typeof sha !== 'string' || sha.startsWith('p2$')) return sha;
            if (!(window.crypto && crypto.subtle)) return sha;
            if (!hashSealGateOpen()) return sha;          // a till still on an older release would not recognise the sealed form yet
            try {
                const salt = await hashSalt();
                const iterations = 100000;
                return `p2$${iterations}$${salt}$${await pbkdf2Hex(sha, salt, iterations)}`;
            } catch (e) { return sha; }
        }

//@fn hashSealGateOpen
// Sealed hashes sync to every device of the shop, and a device still running an OLDER release compares hashes the old way — it would
// refuse the right password. So nothing is sealed until it is safe: once this device has run zip-121+ for 3 days AND the shop's device
// list shows every device seen in the last 14 days on zip-121 or later (hashSealGateCheck). Once open it stays open on this device.
function hashSealGateOpen() {
            try { return localStorage.getItem('pos_hash_seal_ok') === '1'; } catch (e) { return false; }
        }

//@fn hashSealGateCheck
async function hashSealGateCheck() {
            if (hashSealGateOpen()) return true;
            if ((window.posNetOffline && window.posNetOffline()) || typeof fetch !== 'function') return false;
            let since = 0;
            try { since = Number(localStorage.getItem('pos_release_since') || 0); } catch (e) { /* none */ }
            if (!since || Date.now() - since < 3 * 86400000) return false;
            if (window.__sealGateAt && Date.now() - window.__sealGateAt < 6 * 3600000) return false;    // asked at most every 6 hours (reads the device list)
            window.__sealGateAt = Date.now();
            try {
                const res = await fetch(apiUrl('/api/device-pair'));
                if (!res.ok) return false;
                const data = await res.json();
                const recent = (data.devices || []).filter((d) => d && !d.revoked && d.lastSeen && Date.now() - d.lastSeen < 14 * 86400000);
                const rel = (v) => { const m = /zip-(\d+)/.exec(String(v || '')); return m ? Number(m[1]) : 0; };
                if (!recent.length || !recent.every((d) => rel(d.version) >= 121)) return false;
                localStorage.setItem('pos_hash_seal_ok', '1');
                return true;
            } catch (e) { return false; }
        }

//@fn hashMatches
// Does the SHA-256 of what was typed match a stored hash of either form (see sealHash)?
async function hashMatches(enteredSha, stored) {
            if (!enteredSha || !stored || typeof stored !== 'string') return false;
            if (!stored.startsWith('p2$')) return enteredSha === stored;
            const parts = stored.split('$');
            if (parts.length !== 4 || !(window.crypto && crypto.subtle)) return false;
            try { return (await pbkdf2Hex(enteredSha, parts[2], Number(parts[1]) || 100000)) === parts[3]; } catch (e) { return false; }
        }

//@fn sealStoredHashes
// One-time upgrade of every stored password / PIN hash on this device to the salted form (see sealHash) — also run after a pull, so a
// password reset done from the Owner Console (which writes the old form) is sealed by the first device that sees it.
async function sealStoredHashes() {
            if (window.__sealing || !(window.crypto && crypto.subtle)) return false;
            window.__sealing = true;
            let changed = false, pwChanged = false;
            try {
                await hashSealGateCheck();
                for (const k of (hashSealGateOpen() ? ['pos_pw_hash', 'pos_admin_pw_hash', 'aqua_pw_hash', 'aqua_admin_pw_hash'] : [])) {
                    let v = null;
                    try { v = localStorage.getItem(k); } catch (e) { /* none */ }
                    if (v && !v.startsWith('p2$')) { const sealed = await sealHash(v); if (sealed !== v) { safeSetItem(k, sealed); changed = true; pwChanged = true; } }
                }
                if (pwChanged) {
                    // stamp both fields so the sealed form wins on the server, exactly like a password change (see changePassword)
                    window.__fieldAck = window.__fieldAck || new Map();
                    window.__fieldAck.set('pwHash', '__force_stamp__');
                    window.__fieldAck.set('adminPwHash', '__force_stamp__');
                }
                if (hashSealGateOpen() && typeof staff !== 'undefined' && Array.isArray(staff)) {
                    let staffChanged = false;
                    for (const m of staff) {
                        if (m && typeof m.pinHash === 'string' && m.pinHash && !m.pinHash.startsWith('p2$')) {
                            const sealed = await sealHash(m.pinHash);
                            if (sealed !== m.pinHash) { m.pinHash = sealed; m.updatedAt = Date.now(); staffChanged = true; }
                        }
                    }
                    if (staffChanged) {
                        changed = true;
                        if (typeof saveAllLocal === 'function') saveAllLocal(); else safeSetItem('pos_staff', JSON.stringify(staff));
                    }
                }
                // "Stay signed in" remembers the password hash it signed in under (a changed password signs everyone out). The same password,
                // now sealed, is not a change: carry the session over.
                try {
                    const keep = JSON.parse(localStorage.getItem('pos_session_keep') || 'null');
                    const cur = localStorage.getItem('pos_pw_hash') || localStorage.getItem('aqua_pw_hash') || '';
                    const pairKey = keep && keep.fp + '|' + cur;
                    if (keep && keep.fp && cur && keep.fp !== cur && !String(keep.fp).startsWith('p2$') && window.__sealFpChecked !== pairKey) {
                        window.__sealFpChecked = pairKey;          // checked once per pair, not on every tick
                        if (await hashMatches(keep.fp, cur)) { keep.fp = cur; localStorage.setItem('pos_session_keep', JSON.stringify(keep)); }
                    }
                } catch (e) { /* they sign in once more */ }
                if (changed) {
                    if (typeof pushNow === 'function') Promise.resolve(pushNow()).catch(() => {}); else if (typeof queuePush === 'function') queuePush();   // before a pull can bring the old form back
                }
            } catch (e) { /* retried next time */ }
            finally { window.__sealing = false; }
            return changed;
        }

//@fn tillNumber
// This device's till number (1-99), handed out once by the server (see allocateTill in functions/api/_merge.js). 0 = not yet known.
function tillNumber() {
            const n = parseInt((function () { try { return localStorage.getItem('pos_till_no') || '0'; } catch (e) { return '0'; } })(), 10);
            return n >= 1 && n <= 99 ? n : 0;
        }

//@fn rememberTillNumber
function rememberTillNumber(n) {
            n = Number(n);
            if (n >= 1 && n <= 99) { try { localStorage.setItem('pos_till_no', String(n)); } catch (e) { /* asked again on the next sync */ } }
        }

//@fn generateReceiptRef
// The reference printed (and barcoded) on every receipt — unique across ALL tills (zip 119). Before, every till counted up its own
// copy of one shared number and synced it later, so two tills selling at the same time printed the SAME reference. Now each till
// counts its own sales and the reference is (its count x 100) + its till number: till 3's 7th sale is ref-00000703, till 4's is
// ref-00000704 — no two tills can ever produce the same one, online or offline, and it stays all digits (quick to type / scan).
// New references always start above every reference issued before this change (the old shared counter is the floor). A brand-new
// device that has never reached the server has no till number yet: it uses its own device code instead (ref-D<code>-<n>).
function generateReceiptRef() {
            let seq = 0;
            try { seq = parseInt(localStorage.getItem('pos_till_ref_seq') || '0', 10) || 0; } catch (e) { /* start from the floor */ }
            const floor = (typeof nextReceiptRefSeq === 'number' && isFinite(nextReceiptRefSeq)) ? nextReceiptRefSeq : 0;
            if (seq < floor) seq = floor;
            seq += 1;
            safeSetItem('pos_till_ref_seq', String(seq));
            const till = tillNumber();
            const dev = String(getOrCreateDeviceId()).replace(/[^a-z0-9]/gi, '').slice(-5).toUpperCase();
            const ref = till ? `ref-${String(seq * 100 + till).padStart(8, '0')}` : `ref-D${dev}-${seq}`;
            // remember who/where for the sale this reference is about to go on (attached when it is sent: stampLocalContext)
            try {
                const k = 'pos_ref_ctx_v1';
                const map = JSON.parse(localStorage.getItem(k) || '{}') || {};
                map[ref] = { ...saleCtxNow(), at: Date.now() };
                const keys = Object.keys(map);
                if (keys.length > 300) keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0)).slice(0, keys.length - 300).forEach((x) => { delete map[x]; });
                localStorage.setItem(k, JSON.stringify(map));
            } catch (e) { /* the sale still gets its reference */ }
            return ref;
        }

//@fn getPaperCols
function getPaperCols() {
            // Characters per line = what the print head holds in the printer's standard font (Font A: 12 dots = 1.5 mm a character):
            // 58 mm paper -> 48 mm printable -> 32; 80 mm -> 72 mm -> 48. Follows THIS device's printer (see receiptPaperMm). (zip 144)
            const mm = receiptPaperMm();
            if (mm >= 56 && mm <= 58) return 32;
            if (mm >= 80 && mm < 100) return 48;
            return Math.max(20, Math.min(64, Math.floor(receiptPrintableMm(mm) / 1.5)));
        }

//@fn getServiceAvailableQty
function getServiceAvailableQty(product) {
            if (!product.recipe || product.recipe.length === 0) return Infinity;
            let min = Infinity;
            product.recipe.forEach(ing => {
                const item = inventory.find(p => p.code === ing.code);
                const stock = item ? (item.qty || 0) : 0;
                const possible = Math.floor((stock / ing.qtyPerUnit) + 1e-9);
                if (possible < min) min = possible;
            });
            return Math.max(0, min);
        }

//@fn getServiceUnitCost
function getServiceUnitCost(product) {
            if (product.type === 'service' && product.recipe && product.recipe.length) {
                return product.recipe.reduce((sum, ing) => {
                    const item = inventory.find(p => p.code === ing.code);
                    return sum + (ing.qtyPerUnit * (item ? (item.wholesalePrice || 0) : 0));
                }, 0);
            }
            return product.wholesalePrice || 0;
        }

//@fn gridRowsFromSheet
function gridRowsFromSheet(ws) {
            return window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
        }

//@fn handleBillUpfrontSplitChange
function handleBillUpfrontSplitChange() {
            const upfront = parseFloat(document.getElementById('bill-upfront-amount-input').value) || 0;
            const cash = parseFloat(document.getElementById('bill-upfront-split-cash-input').value) || 0;
            const mpesa = parseFloat(document.getElementById('bill-upfront-split-mpesa-input').value) || 0;
            const bank = parseFloat(document.getElementById('bill-upfront-split-bank-input').value) || 0;
            const card = parseFloat(document.getElementById('bill-upfront-split-card-input').value) || 0;
            const line = document.getElementById('bill-upfront-split-balance-line');
            if (!line) return;
            const result = computeSplitBalanceLine(upfront, cash, mpesa, bank, card);
            line.textContent = result.text;
            line.className = `split-balance-line ${result.cls}`;
        }

//@fn handleCaptureListUpload
function handleCaptureListUpload(event) {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (!file) return;
            if (!file.type.startsWith('image/')) { showToast('Please choose a valid image file.', true); return; }
            const reader = new FileReader();
            reader.onload = (e) => runAiCaptureOnImage(e.target.result);
            reader.onerror = () => showToast('Could not read the selected image.', true);
            reader.readAsDataURL(file);
        }

//@fn handleDeliveryPaymentSplitChange
function handleDeliveryPaymentSplitChange(source) {
            const bill = bills.find(b => b.id === pendingDeliveryPaymentSaleId);
            if (!bill) return;
            const outstanding = Math.max(0, (bill.total || 0) - (bill.amountPaid || 0));
            const cashInput = document.getElementById('delivery-payment-split-cash-input');
            const mpesaInput = document.getElementById('delivery-payment-split-mpesa-input');
            const cash = parseFloat(cashInput.value);
            const mpesa = parseFloat(mpesaInput.value);
            if (source === 'cash' && !isNaN(cash)) mpesaInput.value = Math.max(0, Math.round((outstanding - cash) * 100) / 100).toFixed(2);
            else if (source === 'mpesa' && !isNaN(mpesa)) cashInput.value = Math.max(0, Math.round((outstanding - mpesa) * 100) / 100).toFixed(2);
        }

//@fn handleExchangeSplitChange
function handleExchangeSplitChange(changed) {
            const netPayable = getExchangeNetPayable();
            const cashInput = document.getElementById('exchange-split-cash-input');
            const mpesaInput = document.getElementById('exchange-split-mpesa-input');
            if (changed === 'cash') {
                const cash = parseFloat(cashInput.value) || 0;
                mpesaInput.value = Math.max(0, netPayable - cash).toFixed(2);
            } else {
                const mpesa = parseFloat(mpesaInput.value) || 0;
                cashInput.value = Math.max(0, netPayable - mpesa).toFixed(2);
            }
        }

//@fn handleImageUpload
function handleImageUpload(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                showToast('Please choose a valid image file.', true);
                return;
            }

            compressImageToTarget(file, { maxW: 400, maxH: 400, maxBytes: 60 * 1024 })
                .then((result) => {
                    currentCapturedImageBase64 = result.dataUrl;
                    document.getElementById('photo-preview-element').src = currentCapturedImageBase64;
                    showToast(`Image loaded (${formatFileSize(result.originalBytes)} → ${formatFileSize(result.compressedBytes)}).`);
                })
                .catch((err) => showToast(err.message || 'Could not read the selected image.', true));
        }

//@fn handleSplitAmountChange
function handleSplitAmountChange(source) {
            const total = cartTotal();
            const cashInput = document.getElementById('split-cash-input');
            const mpesaInput = document.getElementById('split-mpesa-input');
            const cash = parseFloat(cashInput.value);
            const mpesa = parseFloat(mpesaInput.value);

            if (source === 'cash' && !isNaN(cash)) {
                const remainder = Math.max(0, Math.round((total - cash) * 100) / 100);
                mpesaInput.value = remainder.toFixed(2);
            } else if (source === 'mpesa' && !isNaN(mpesa)) {
                const remainder = Math.max(0, Math.round((total - mpesa) * 100) / 100);
                cashInput.value = remainder.toFixed(2);
            }
            updateSplitBalanceLine();
            updateChangeDue();
        }

//@fn heartbeatDeviceNetwork
async function heartbeatDeviceNetwork() {
            try {
                await fetch(apiUrl('/api/print-relay'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'registerDevice',
                        deviceId: thisDeviceId,
                        name: thisDeviceName,
                        station: thisDeviceStation,
                        printerMode,
                        hasPrinter: printRelayHasRealPrinter(),
                        acceptsRelay: printRelayServerEnabled,
                    }),
                });
            } catch (e) {
                // Silent background heartbeat — same reasoning as pollPrintRelayJobs.
            }
        }

//@fn ingredientOptionsHtml
function ingredientOptionsHtml(selectedCode) {
            // A recipe can draw on a dedicated ingredient OR a normal sellable item —
            // a bar pours the same bottled soda it also sells by the bottle.
            const components = inventory.filter(isRecipeComponent)
                .sort((a, b) => a.name.localeCompare(b.name));
            const ingredients = components.filter(isIngredientProduct);
            const items = components.filter(p => !isIngredientProduct(p));

            const optionFor = (p) => `<option value="${escapeHtml(p.code)}" ${p.code === selectedCode ? 'selected' : ''}>${escapeHtml(p.name)} (${formatQtyDisplay(p.qty, p.unit)} ${unitLabel(p.unit)} in stock)</option>`;

            let html = `<option value="">— choose ingredient —</option>`;
            if (ingredients.length) {
                html += `<optgroup label="🧂 Ingredients">` + ingredients.map(optionFor).join('') + `</optgroup>`;
            }
            if (items.length) {
                html += `<optgroup label="📦 Items">` + items.map(optionFor).join('') + `</optgroup>`;
            }
            return html;
        }

//@fn initBulkAddForm
function initBulkAddForm() {
            const categoryInput = document.getElementById('bulk-category-input');
            if (categoryInput) categoryInput.value = '';
            bulkCategory = '';
            bulkAddRows = [makeBulkRow(), makeBulkRow(), makeBulkRow()];
            document.getElementById('bulk-add-error').textContent = '';
            renderBulkAddTable();
        }

//@fn initCamera
function initCamera() {
            const statusEl = document.getElementById('camera-status');
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                if (statusEl) statusEl.textContent = 'Camera not supported on this device/browser.';
                return;
            }
            navigator.mediaDevices.getUserMedia({ video: true })
                .then(stream => {
                    videoStream = stream;
                    const video = document.getElementById('video');
                    video.srcObject = stream;
                    if (statusEl) statusEl.textContent = '';
                })
                .catch(err => {
                    if (statusEl) statusEl.textContent = 'Camera unavailable (permission denied or no device found).';
                });
        }

//@fn initCameraScanOnLoad
async function initCameraScanOnLoad() {
            const toggle = document.getElementById('camera-scan-toggle');
            if (toggle) toggle.checked = cameraScanEnabled;
            if (cameraScanEnabled) await startBackgroundCameraScan();
        }

//@fn initCustomerDisplayMode
function initCustomerDisplayMode() {
            document.title = 'Customer Display';
            const view = document.getElementById('customer-display-view');
            view.classList.add('show');

            const brandEl = document.getElementById('cd-brand-name');
            const storedBiz = localStorage.getItem('pos_biz_name');
            if (storedBiz) brandEl.textContent = storedBiz;

            const idleEl = document.getElementById('cd-idle-view');
            const activeEl = document.getElementById('cd-active-view');
            const changeEl = document.getElementById('cd-change-view');

            function showOnly(el) {
                [idleEl, activeEl, changeEl].forEach(e => { e.style.display = e === el ? 'block' : 'none'; });
            }

            function render(payload) {
                if (!payload) { showOnly(idleEl); return; }
                if (payload.businessName) brandEl.textContent = payload.businessName;

                if (payload.mode === 'change') {
                    showOnly(changeEl);
                    document.getElementById('cd-change-value').textContent = payload.change > 0
                        ? `Change: KES ${payload.change.toFixed(2)}`
                        : `Total: KES ${payload.total.toFixed(2)}`;
                } else if (payload.mode === 'cart' && payload.items && payload.items.length) {
                    showOnly(activeEl);
                    document.getElementById('cd-total-value').textContent = `KES ${payload.total.toFixed(2)}`;
                    document.getElementById('cd-items-list').innerHTML = payload.items
                        .map(i => `${formatQtyDisplay(i.qty, i.unit)} × ${escapeHtml(i.name)}`)
                        .join('<br>');
                } else {
                    showOnly(idleEl);
                }
            }

            // Whatever the cashier's window last wrote might already be sitting in
            // localStorage if this display opens mid-sale — show it immediately
            // instead of waiting for the next cart change.
            try {
                const raw = localStorage.getItem('pos_customer_display_state');
                render(raw ? JSON.parse(raw) : null);
            } catch (e) {
                showOnly(idleEl);
            }

            // 'storage' fires in every OTHER same-origin window/tab the instant one
            // of them writes to localStorage — exactly what's needed here, and it
            // never fires in the window that made the write, so there's no echo loop.
            window.addEventListener('storage', (e) => {
                if (e.key !== 'pos_customer_display_state') return;
                try {
                    render(e.newValue ? JSON.parse(e.newValue) : null);
                } catch (err) {
                    showOnly(idleEl);
                }
            });
        }

//@fn initDeviceNetworkUI
function initDeviceNetworkUI() {
            const nameInput = document.getElementById('device-name-input');
            const stationSelect = document.getElementById('device-station-select');
            if (nameInput) nameInput.value = thisDeviceName;
            if (stationSelect) stationSelect.value = thisDeviceStation;
            refreshDeviceNetworkList();
            loadPrintRoutingRules();
        }

//@fn initGasSettingsUI
function initGasSettingsUI() {
            const toggle = document.getElementById('gas-refills-enabled-toggle');
            if (toggle) toggle.checked = doGasRefills;
        }

//@fn initLoyaltySettingsUI
function initLoyaltySettingsUI() {
            const toggle = document.getElementById('loyalty-enabled-toggle');
            if (toggle) toggle.checked = loyaltyEnabled;
            const panel = document.getElementById('loyalty-config-panel');
            if (panel) panel.style.display = loyaltyEnabled ? 'block' : 'none';
            const valueInput = document.getElementById('loyalty-token-value-input');
            if (valueInput) valueInput.value = tokenValueKES;
            renderLoyaltyTiersList();
        }

//@fn initPasswordToggles
function initPasswordToggles() {
            document.querySelectorAll('input[type="password"]').forEach((input) => {
                if (input.dataset.pwToggleInit) return;
                input.dataset.pwToggleInit = '1';

                const wrap = document.createElement('span');
                wrap.className = 'pw-toggle-wrap';
                input.parentNode.insertBefore(wrap, input);
                wrap.appendChild(input);

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'pw-toggle-btn';
                btn.title = 'Show/hide password';
                btn.textContent = '👁';
                btn.onmousedown = (e) => e.preventDefault(); // keep focus on the field, not the button
                btn.onclick = () => {
                    const showing = input.type === 'text';
                    input.type = showing ? 'password' : 'text';
                    btn.textContent = showing ? '👁' : '🙈';
                    btn.classList.toggle('active', !showing);
                };
                wrap.appendChild(btn);
            });
        }

//@fn initPhonebookPickers
function initPhonebookPickers(root) {
            const scope = root && root.querySelectorAll ? root : document;
            scope.querySelectorAll('input').forEach((input) => {
                if (input.dataset.phonePickerInit) return;
                if (!isPhoneField(input)) return;
                input.dataset.phonePickerInit = '1';

                const wrap = document.createElement('span');
                wrap.className = 'phone-picker-wrap';
                input.parentNode.insertBefore(wrap, input);
                wrap.appendChild(input);

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'phone-picker-btn';
                btn.title = 'Import from phonebook';
                btn.setAttribute('aria-label', 'Import from phonebook');
                btn.textContent = '📇';
                btn.onmousedown = (e) => e.preventDefault(); // keep focus on the field, not the button
                btn.onclick = () => pickPhoneForField(btn);
                wrap.appendChild(btn);
            });
        }

//@fn invCellKey
function invCellKey(id, field) {
            return id + '::' + field;
        }

//@fn isAdminServing
function isAdminServing() {
            return !currentServer;
        }

//@fn isBillNotifRelevant
function isBillNotifRelevant(n) {
            if (currentNotifViewerId() === '__owner__') return true;
            return (n.recipientStaffIds || []).includes(currentNotifViewerId());
        }

//@fn isExpired
function isExpired(expiryDate) {
            const days = daysUntilExpiry(expiryDate);
            return days !== null && days < 0;
        }

//@fn isExpiringSoon
function isExpiringSoon(expiryDate) {
            const days = daysUntilExpiry(expiryDate);
            return days !== null && days >= 0 && days <= EXPIRY_WARNING_DAYS;
        }

//@fn isIngredientProduct
function isIngredientProduct(p) { return productType(p) === 'ingredient'; }

//@fn isKeyboardTypeable
function isKeyboardTypeable(el) {
            if (!el || el.disabled || el.readOnly) return false;
            if (el.closest && el.closest('#floating-keyboard-panel')) return false;
            if (el.isContentEditable) return true;
            if (el.tagName === 'TEXTAREA') return true;
            if (el.tagName !== 'INPUT') return false;
            return !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image'].includes(el.type);
        }

//@fn isOfferActive
function isOfferActive(product) {
            return !!(product && product.offer && product.offer.endAt && new Date(product.offer.endAt).getTime() > Date.now());
        }

//@fn isPhoneField
function isPhoneField(el) {
            if (!el || el.tagName !== 'INPUT') return false;
            if (el.type === 'tel') return true;
            if (el.type !== 'text') return false;
            const id = (el.id || '').toLowerCase();
            if (id.includes('phone')) return true;
            const ph = (el.getAttribute('placeholder') || '').trim();
            return !id && ph === 'Phone';
        }

//@fn isRecipeComponent
function isRecipeComponent(p) { return isStockedProduct(p); }

//@fn isRunningStandalone
function isRunningStandalone() {
            return window.matchMedia('(display-mode: standalone)').matches
                || window.matchMedia('(display-mode: fullscreen)').matches
                || window.navigator.standalone === true; // iOS Safari
        }

//@fn isSellableProduct
function isSellableProduct(p) { return productType(p) !== 'ingredient'; }

//@fn isServiceProduct
function isServiceProduct(p) { return productType(p) === 'service'; }

//@fn isStaffLockedToday
function isStaffLockedToday(member) {
            const today = todayLocalDateStr();
            // An admin's "Open Account (Today)" override beats every other lock
            // rule for today specifically — tomorrow, the normal schedule (locked
            // dates, recurring weekday locks) applies again untouched.
            if (member.openAccountOverrideDate === today) return false;
            if (member.lockedDates && member.lockedDates.includes(today)) return true;
            if (Array.isArray(member.lockedWeekdays) && member.lockedWeekdays.length) {
                if (member.lockedWeekdays.includes(new Date().getDay())) return true;
            }
            return false;
        }

//@fn itemOffers
function itemOffers(code) {
            return offers.filter(o => o.scope === 'items' && (o.targets || []).some(t => t.kind === 'code' && t.code === code));
        }

//@fn itemTotalSold
function itemTotalSold(code) {
            return soldTotalsMap()[code] || 0;
        }

//@fn soldTotalsMap
function soldTotalsMap() {
            // Units sold per item code, counted in ONE pass over the sales log and remembered. This used to be a full pass over every sale for every
            // item, every time the Sales Counter's items grid was drawn (each keystroke in the search box, each sale, each sync): with 1,500 items and
            // 6,000 sales that is millions of comparisons per redraw — the main reason a busy shop's till "hung". Remembered until the sales change
            // (or 20 s pass, which also picks up a void).
            const c = window.__soldCache;
            if (c && c.ref === salesLog && c.len === salesLog.length && Date.now() - c.at < 20000) return c.map;
            const map = Object.create(null);
            for (let i = 0; i < salesLog.length; i++) {
                const sale = salesLog[i];
                if (!sale || sale.voided || !sale.items) continue;
                for (let j = 0; j < sale.items.length; j++) {
                    const it = sale.items[j];
                    if (it && it.code != null) map[it.code] = (map[it.code] || 0) + (it.qty || 0);
                }
            }
            window.__soldCache = { ref: salesLog, len: salesLog.length, at: Date.now(), map };
            return map;
        }

//@fn jpegBytesToPdfBlob
function jpegBytesToPdfBlob(jpegBytes, pxWidth, pxHeight, opts) {
            const ptPerPx = (opts && opts.ptPerPx) || 0.75;
            const pageW = pxWidth * ptPerPx;
            const pageH = pxHeight * ptPerPx;

            const textEncoder = new TextEncoder();
            const chunks = [];
            const offsets = [];
            let pos = 0;
            function push(part) {
                const bytes = typeof part === 'string' ? textEncoder.encode(part) : part;
                chunks.push(bytes);
                pos += bytes.length;
            }
            function beginObj(num) {
                offsets[num - 1] = pos;
                push(`${num} 0 obj\n`);
            }

            push('%PDF-1.4\n');
            beginObj(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
            beginObj(2); push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
            beginObj(3); push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
            beginObj(4);
            push(`<< /Type /XObject /Subtype /Image /Width ${pxWidth} /Height ${pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
            push(jpegBytes);
            push('\nendstream\nendobj\n');
            const content = `q ${pageW.toFixed(2)} 0 0 ${pageH.toFixed(2)} 0 0 cm /Im0 Do Q`;
            beginObj(5); push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

            const xrefStart = pos;
            push('xref\n');
            push(`0 ${offsets.length + 1}\n`);
            push('0000000000 65535 f \n');
            offsets.forEach((off) => push(`${String(off).padStart(10, '0')} 00000 n \n`));
            push('trailer\n');
            push(`<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

            return new Blob(chunks, { type: 'application/pdf' });
        }

//@fn jumpToSaleByRef
function jumpToSaleByRef(query) {
            const q = (query || '').trim().toLowerCase();
            if (!q) return;
            const sale = salesLog.find(s => (s.refNumber || '').toLowerCase() === q) ||
                (!q.startsWith('ref-') ? salesLog.find(s => (s.refNumber || '').toLowerCase() === `ref-${q.padStart(8, '0')}`) : null);
            if (!sale) return;

            const saleDate = new Date(sale.timestamp);
            const yyyy = saleDate.getFullYear();
            const mm = String(saleDate.getMonth() + 1).padStart(2, '0');
            const dd = String(saleDate.getDate()).padStart(2, '0');
            const picker = document.getElementById('sales-table-date-picker');
            if (picker) { picker.value = `${yyyy}-${mm}-${dd}`; picker.dataset.auto = '0'; }
            setSalesTablePeriod('daily'); // jump always lands on the Daily preset, showing just that sale's day
            showToast(`Found ${sale.refNumber} — jumped to ${saleDate.toLocaleDateString('en-GB')}.`);
        }

//@fn kbBackspace
function kbBackspace() {
            const el = kbResolveTarget();
            if (!el) {
                showToast('Tap an input field first.', true);
                return;
            }

            if (el.isContentEditable) {
                el.focus();
                document.execCommand('delete');
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }

            // Same InvalidStateError trap as kbInsertText — number/date/email fields
            // have no readable caret, so just drop the last character.
            if (el.tagName === 'INPUT' && KB_NO_SELECTION_TYPES.includes(el.type)) {
                el.value = String(el.value || '').slice(0, -1);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.focus();
                return;
            }

            let start, end;
            try {
                start = el.selectionStart != null ? el.selectionStart : el.value.length;
                end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
            } catch (e) {
                start = end = el.value.length;
            }
            if (start === end) {
                if (start === 0) return;
                el.value = el.value.slice(0, start - 1) + el.value.slice(end);
                const p = start - 1;
                if (el.setSelectionRange) { try { el.setSelectionRange(p, p); } catch (e) {} }
            } else {
                el.value = el.value.slice(0, start) + el.value.slice(end);
                if (el.setSelectionRange) { try { el.setSelectionRange(start, start); } catch (e) {} }
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.focus();
        }

//@fn kbEnter
function kbEnter() {
            const el = kbLastTarget;
            if (!el || !document.body.contains(el)) {
                showToast('Tap an input field first.', true);
                return;
            }
            if (el.tagName === 'TEXTAREA') {
                kbInsertText('\n');
                return;
            }
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }

//@fn kbInsertText
function kbInsertText(text) {
            const el = kbResolveTarget();
            if (!el) {
                showToast('Tap an input field first, then use the keyboard.', true);
                return;
            }

            if (el.isContentEditable) {
                el.focus();
                document.execCommand('insertText', false, text);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }

            // Fields without selection support: append at the end, since there's no
            // caret position to read.
            if (el.tagName === 'INPUT' && KB_NO_SELECTION_TYPES.includes(el.type)) {
                el.value = (el.value || '') + text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.focus();
                return;
            }

            let start, end;
            try {
                start = el.selectionStart != null ? el.selectionStart : el.value.length;
                end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
            } catch (e) {
                start = end = el.value.length;
            }
            el.value = el.value.slice(0, start) + text + el.value.slice(end);
            const newPos = start + text.length;
            if (el.setSelectionRange) { try { el.setSelectionRange(newPos, newPos); } catch (e) {} }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.focus();
        }

//@fn kbKeyTap
function kbKeyTap(btnEl) {
            const ch = btnEl.dataset.key;
            kbInsertText(kbShift ? ch.toUpperCase() : ch);
        }

//@fn kbResolveTarget
function kbResolveTarget() {
            if (kbLastTarget && document.body.contains(kbLastTarget) && !kbLastTarget.disabled && !kbLastTarget.readOnly) {
                return kbLastTarget;
            }
            if (kbLastTargetId) {
                const fresh = document.getElementById(kbLastTargetId);
                if (isKeyboardTypeable(fresh)) {
                    kbLastTarget = fresh;
                    return fresh;
                }
            }
            // Last resort: whatever is focused right now.
            if (isKeyboardTypeable(document.activeElement)) {
                kbLastTarget = document.activeElement;
                return kbLastTarget;
            }
            return null;
        }

//@fn kbSwitchMode
function kbSwitchMode(mode) {
            document.getElementById('kb-layout-letters').style.display = mode === 'letters' ? 'block' : 'none';
            document.getElementById('kb-layout-symbols').style.display = mode === 'symbols' ? 'block' : 'none';
        }

//@fn kbToggleShift
function kbToggleShift() {
            kbShift = !kbShift;
            const shiftBtn = document.getElementById('kb-shift-btn');
            if (shiftBtn) shiftBtn.classList.toggle('active', kbShift);
            document.querySelectorAll('#kb-layout-letters .kb-letter').forEach((btn) => {
                const k = btn.dataset.key;
                btn.textContent = kbShift ? k.toUpperCase() : k;
            });
        }

//@fn kitchenTicketPrintJob
async function kitchenTicketPrintJob() {
            const text = lastKitchenTicketText;
            if (printerMode === 'bluetooth' && btPrinterCharacteristic) {
                await printViaBluetooth(text);
                return;
            }
            if (printerMode === 'usb' && usbPrinterDevice && usbPrinterEndpoint !== null) {
                await printViaUSB(text);
                return;
            }
            // System dialog: opens a second print job right after the receipt's.
            // The cashier gets two dialogs per sale in this mode — flagged in the
            // Settings hint text so it isn't a surprise.
            await printKitchenTicketViaSystemDialog();
        }

//@fn linkRecoveryEmail
async function linkRecoveryEmail() {
            const emailEl = document.getElementById('recovery-email-input');
            const pwEl = document.getElementById('recovery-password-input');
            const msgEl = document.getElementById('recovery-link-msg');
            msgEl.className = 'settings-msg';
            msgEl.textContent = 'Linking…';
            try {
                const res = await fetch(apiUrl('/api/account-recovery'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'link', email: emailEl.value.trim(), password: pwEl.value }),
                });
                const data = await res.json();
                if (!res.ok || data.error) throw new Error(data.error || 'Could not link this email.');
                msgEl.className = 'settings-msg success';
                msgEl.textContent = `Linked to ${data.email}.`;
                emailEl.value = '';
                pwEl.value = '';
                loadRecoveryStatus();
            } catch (e) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = e.message;
            }
        }

//@fn listWebAuthnCredentials
async function listWebAuthnCredentials() {
            try {
                const db = await openWebAuthnDb();
                return await new Promise((resolve, reject) => {
                    const tx = db.transaction(WEBAUTHN_STORE, 'readonly');
                    const req = tx.objectStore(WEBAUTHN_STORE).getAll();
                    req.onsuccess = () => resolve(req.result || []);
                    req.onerror = () => reject(req.error);
                });
            } catch (e) {
                return [];
            }
        }

//@fn loadBackupsList
async function loadBackupsList() {
            const wrap = document.getElementById('backups-list');
            if (!wrap) return;
            wrap.innerHTML = '<p class="settings-msg">Checking…</p>';
            try {
                const res = await fetch(apiUrl('/api/backups'));
                if (!res.ok) throw new Error('request failed');
                const data = await res.json();
                if (!data.dates || data.dates.length === 0) {
                    wrap.innerHTML = '<p class="settings-msg">No backups yet — one is taken automatically the first time any device syncs each day.</p>';
                    return;
                }
                wrap.innerHTML = data.dates.map(date => `
                    <div class="settings-row" style="justify-content:space-between;">
                        <span>${escapeHtml(date)}</span>
                        <button class="settings-small-btn" onclick="requestRestoreBackup('${escapeJsAttr(date)}')">Restore This Day</button>
                    </div>
                `).join('');
            } catch (e) {
                wrap.innerHTML = '<p class="settings-msg error">Could not reach the server to check for backups.</p>';
            }
        }

//@fn loadContractForMoreItems
function loadContractForMoreItems(contractId) {
            const contract = contracts.find(c => c.id === contractId);
            if (!contract) return;
            document.getElementById('contract-name-input').value = contract.name;
            document.getElementById('contract-phone-input').value = contract.phone || '';
            activeContractId = contract.id;
            setContractType(contract.type);
            document.getElementById('contract-type-retail-btn').disabled = true;
            document.getElementById('contract-type-wholesale-btn').disabled = true;
            document.getElementById('contract-existing-group').style.display = 'block';
            document.getElementById('contract-existing-hint').textContent = `Adding a new visit to ${contract.name}'s existing ${contract.type === 'wholesale' ? 'Wholesale' : 'Retail'} contract.`;
            contractDraft = [];
            addContractRow();
            document.getElementById('contracts-tab').scrollIntoView({ behavior: 'smooth' });
        }

//@fn loadNotifiedToday
function loadNotifiedToday() {
            try {
                const raw = safeJSONParse(NOTIF_SEEN_KEY, {});
                // Wipe yesterday's record so each day starts fresh.
                if (raw.date !== todayLocalDateStr()) return { date: todayLocalDateStr(), keys: [] };
                return { date: raw.date, keys: Array.isArray(raw.keys) ? raw.keys : [] };
            } catch (e) {
                return { date: todayLocalDateStr(), keys: [] };
            }
        }

//@fn loadPrintRoutingRules
async function loadPrintRoutingRules() {
            try {
                const res = await fetch(apiUrl('/api/print-relay'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'getRules' }),
                });
                const data = await res.json();
                printRoutingRules = (res.ok && Array.isArray(data.rules)) ? data.rules : [];
            } catch (e) {
                printRoutingRules = [];
            }
            renderPrintRoutingRulesList();
        }

//@fn loadRecoveryStatus
async function loadRecoveryStatus() {
            const statusEl = document.getElementById('email-recovery-status');
            const linkFields = document.getElementById('email-recovery-link-fields');
            const unlinkBtn = document.getElementById('unlink-recovery-btn');
            statusEl.textContent = 'Checking…';
            try {
                const res = await fetch(apiUrl('/api/account-recovery'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'status' }),
                });
                const data = await res.json();
                if (!res.ok || data.error) throw new Error(data.error || 'Could not check status.');
                if (data.linked) {
                    statusEl.textContent = `✅ Linked to ${data.email}. You can reset your password from the login screen, or sign in with this email on a new device.`;
                    linkFields.style.display = 'none';
                    unlinkBtn.style.display = 'inline-block';
                } else {
                    statusEl.textContent = 'No email linked yet.';
                    linkFields.style.display = 'block';
                    unlinkBtn.style.display = 'none';
                }
            } catch (e) {
                statusEl.textContent = netErrText('Could not reach the server');
            }
        }

//@fn loadSheetJsOnce
function loadSheetJsOnce(url) {
            return new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = url;
                script.onload = () => resolve();
                script.onerror = () => reject(new Error('load failed: ' + url));
                document.head.appendChild(script);
            });
        }

//@fn loadStoreItems
async function loadStoreItems(forceRefresh) {
            if (!myBranchGroupId) return [];
            if (!forceRefresh && storeItemsCache.length > 0) return storeItemsCache;
            try {
                const res = await fetch(apiUrl('/api/store'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'get' }),
                });
                const data = await res.json();
                if (!res.ok || data.error) return [];
                storeItemsCache = data.items || [];
                return storeItemsCache;
            } catch (e) {
                return [];
            }
        }

//@fn loadUpgradePromptContent
async function loadUpgradePromptContent() {
            try {
                const res = await fetch(apiUrl('/api/website-content'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'get' }),
                });
                const data = await res.json();
                if (res.ok && data.content) {
                    cachedUpgradePrice = data.content.price;
                    cachedUpgradePhone = data.content.paymentPhone;
                    cachedAltPaymentMethods = data.content.alternatePaymentMethods || [];
                    updateLicenseLockHintText();
                }
            } catch (e) {
                // Silent — falls back to the defaults above, the same
                // numbers that were hardcoded here before this was made
                // centrally configurable.
            }
        }

//@fn logStockMovementDated
function logStockMovementDated(code, name, delta, reason, isoTimestamp) {
            if (!delta) return;
            stockMovementLog.push({ id: genSaleId(), lg: 1, timestamp: isoTimestamp, code, name, delta, type: delta > 0 ? 'added' : 'removed', reason });
        }

//@fn looksLikeRowNumberColumn
function looksLikeRowNumberColumn(c, sample) {
            if (sample.length < 3) return false;
            return sample.every((r, i) => {
                const raw = r[c];
                if (raw === undefined || raw === null || String(raw).trim() === '') return false;
                return extractNumber(raw) === i + 1;
            });
        }

//@fn lookupBarcode
async function lookupBarcode(code) {
            const res = await fetch(apiUrl(`/api/barcode-lookup?code=${encodeURIComponent(code)}`));
            if (!res.ok) return null;
            return res.json();
        }

//@fn markAllBillNotificationsRead
function markAllBillNotificationsRead() {
            const viewer = currentNotifViewerId();
            let changed = false;
            unreadBillNotifications().forEach(n => {
                if (!n.readBy) n.readBy = [];
                if (!n.readBy.includes(viewer)) { n.readBy.push(viewer); changed = true; }
            });
            if (changed) {
                safeSetItem('pos_bill_notifications', JSON.stringify(billNotifications));
                queuePush();
            }
            renderNotifications();
        }

//@fn markBillNotificationRead
function markBillNotificationRead(id) {
            const viewer = currentNotifViewerId();
            const n = billNotifications.find(x => x.id === id);
            if (!n) return;
            if (!n.readBy) n.readBy = [];
            if (!n.readBy.includes(viewer)) n.readBy.push(viewer);
            safeSetItem('pos_bill_notifications', JSON.stringify(billNotifications));
            queuePush();
            renderNotifications();
        }

//@fn markDeliveryNotificationsRead
function markDeliveryNotificationsRead() {
            deliveryNotifications.forEach(n => {
                if (!currentServer || n.agentKey === currentServer.id) n.read = true;
            });
            queuePush();
            renderDeliveriesTab();
        }

//@fn markTillPaymentMatched
async function markTillPaymentMatched(transId, matched) {
            try {
                await fetch(apiUrl('/api/till-payments'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transId, matched }),
                });
                renderTillPayments();
            } catch (e) {
                showToast('Could not update — try again.', true);
            }
        }

//@fn maybeAutoDetectCustomerDisplay
async function maybeAutoDetectCustomerDisplay() {
            if (customerDisplayAutoAttempted) return;
            if (!('getScreenDetails' in window) || !window.screen || !window.screen.isExtended) return;
            customerDisplayAutoAttempted = true;

            let permState = 'prompt';
            try {
                const status = await navigator.permissions.query({ name: 'window-management' });
                permState = status.state;
            } catch (e) {
                // Permissions API doesn't know this name in this browser —
                // fall through to asking via the banner below instead.
            }

            if (permState === 'granted') {
                openCustomerDisplayOnSecondScreen();
            } else if (permState === 'prompt') {
                showCustomerDisplayDetectBanner();
            }
            // 'denied' — respect that choice, stay quiet.
        }

//@fn maybeFetchAutoImage
async function maybeFetchAutoImage(code, name) {
            if (window.posNetOffline ? window.posNetOffline() : !navigator.onLine) return;
            try {
                const res = await fetch(apiUrl(`/api/image-search?q=${encodeURIComponent(name)}`));
                const data = await res.json();
                if (!res.ok || !data.imageDataUrl) return;

                const product = inventory.find(p => p.code === code);
                if (!product || product.image) return;
                product.image = data.imageDataUrl;
                safeSetItem('pos_inventory', JSON.stringify(inventory));
                queuePush();
                renderInventoryTable();
                if ((product.type || 'item') === 'service' && typeof renderServicesTable === 'function') renderServicesTable();
            } catch (e) {
                // Silent — a nice-to-have background enhancement, not something
                // that should ever interrupt or alarm someone adding an item.
            }
        }

//@fn maybeOfferNotificationPrompt
function maybeOfferNotificationPrompt() {
            if (!notificationsSupported()) return;
            if (Notification.permission !== 'default') return; // already decided, nothing to ask
            const lastPrompted = parseInt(localStorage.getItem('pos_notif_prompt_last') || '0', 10);
            if (Date.now() - lastPrompted < 3 * 24 * 60 * 60 * 1000) return; // don't ask more than once every 3 days
            showNotificationPromptBanner();
        }

//@fn maybeSendBillCreatedSms
async function maybeSendBillCreatedSms(bill) {
            const phone = bill.customerPhone || bill.mpesaPhone;
            if (!phone) return;
            try {
                const statusRes = await fetch(apiUrl('/api/sms-config?status=1'));
                const status = await statusRes.json();
                if (!status.configured) return;
                const itemsTotal = (bill.items || []).reduce((sum, l) => sum + l.price * l.qty, 0);
                const owed = Math.max(0, itemsTotal - (bill.amountPaid || 0));
                const message = buildBillOwedMessage(bill.customerName, owed);
                await fetch(apiUrl('/api/sms-send'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ to: phone, message }),
                });
            } catch (e) {
                // Quiet — the bill itself already went through successfully.
            }
        }

//@fn maybeSendThankYouSms
async function maybeSendThankYouSms(phone, customerName, amount) {
            if (!phone) return;
            try {
                const res = await fetch(apiUrl('/api/sms-config?status=1'));
                const status = await res.json();
                if (!status.configured || !status.autoThankYouEnabled) return;
                const template = status.thankYouTemplate || 'Thank you {name} for your payment of KES {amount} to {business}. We appreciate your business!';
                const message = fillSmsTemplate(template, { name: customerName, amount, business: businessName });
                await fetch(apiUrl('/api/sms-send'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ to: phone, message }),
                });
            } catch (e) {
                // Never let an SMS failure block or interrupt a checkout that's
                // already completed — the sale itself already succeeded.
            }
        }

//@fn maybeShowExpiryNudge
function maybeShowExpiryNudge() {
            if (licenseInfo.type !== 'demo' || licenseInfo.paymentClaimed) return;
            if ((licenseInfo.remainingMs || Infinity) > EXPIRY_NUDGE_THRESHOLD_MS) return;
            if (!myClientId) return; // no identity yet to key the "already shown" flag on

            const key = `pos_expiry_nudge_shown_${myClientId}`;
            if (localStorage.getItem(key)) return;

            const lockScreen = document.getElementById('license-lock-screen');
            if (lockScreen && lockScreen.style.display === 'flex') return; // something's already showing

            safeSetItem(key, '1');
            showUpgradeScreen();
        }

//@fn migrateIngredientsToItems
function migrateIngredientsToItems(list) {
            let converted = 0;
            list.forEach(p => {
                if (p.type === 'ingredient') {
                    p.type = 'item';
                    converted++;
                }
            });
            return converted;
        }

//@fn money
function money(n) { return `KES ${(n || 0).toFixed(2)}`; }

//@fn nextDeliveryStatus
function nextDeliveryStatus(status) {
            if (status === 'assigned') return 'picked_up';
            if (status === 'picked_up') return 'on_route';
            return 'delivered';
        }

//@fn nextDeliveryStatusActionLabel
function nextDeliveryStatusActionLabel(status) {
            if (status === 'assigned') return '📦 Mark Picked Up';
            if (status === 'picked_up') return '🚴 Mark On Route';
            return '✅ Mark Delivered';
        }

//@fn normalizeKenyanPhone
function normalizeKenyanPhone(raw) {
            let p = (raw || '').replace(/\D/g, '');
            if (p.startsWith('0')) p = '254' + p.slice(1);
            else if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
            return p;
        }

//@fn notificationsSupported
function notificationsSupported() {
            return typeof Notification !== 'undefined';
        }

//@fn offerAvailableCategories
function offerAvailableCategories() {
            const set = new Set();
            inventory.forEach(p => { if (p.category) set.add(p.category); });
            return Array.from(set).sort();
        }

//@fn offerSummaryLine
function offerSummaryLine(offer) {
            if (offer.type === 'bogo') {
                const pct = offer.freeDiscountPercent == null ? 100 : offer.freeDiscountPercent;
                return pct >= 100 ? `Buy ${offer.buyQty} Get ${offer.freeQty} Free` : `Buy ${offer.buyQty} Get ${offer.freeQty} at ${pct}% Off`;
            }
            if (offer.type === 'percent') return `${offer.percentOff}% Off`;
            if (offer.type === 'flat') return `KES ${offer.flatAmount} Off (min qty ${offer.minQty || 1})`;
            if (offer.type === 'bundle') return `${offer.bundleQty} for ${money(offer.bundlePrice)}`;
            return '';
        }

//@fn onBillUpfrontAmountChange
function onBillUpfrontAmountChange() {
            const amount = parseFloat(document.getElementById('bill-upfront-amount-input').value) || 0;
            document.getElementById('bill-upfront-method-row').style.display = amount > 0 ? 'block' : 'none';
        }

//@fn onBulkCategoryChanged
function onBulkCategoryChanged(value) {
            bulkCategory = value;
            bulkAddRows.forEach(row => {
                if (row.nameDirty) return;
                row.name = buildInventoryItemName('', bulkCategory, row.code);
                const nameInput = document.getElementById(row.id + '-name');
                if (nameInput) nameInput.value = row.name;
            });
        }

//@fn onBulkRowCodeInput
function onBulkRowCodeInput(id, value) {
            const row = bulkAddRows.find(r => r.id === id);
            if (!row) return;
            row.code = value;
            if (!row.nameDirty) {
                row.name = buildInventoryItemName('', bulkCategory, row.code);
                const nameInput = document.getElementById(id + '-name');
                if (nameInput) nameInput.value = row.name;
            }
        }

//@fn onBulkRowFieldInput
function onBulkRowFieldInput(id, field, value) {
            const row = bulkAddRows.find(r => r.id === id);
            if (row) row[field] = value;
        }

//@fn onBulkRowNameInput
function onBulkRowNameInput(id, value) {
            const row = bulkAddRows.find(r => r.id === id);
            if (!row) return;
            row.name = value;
            // An empty name (cleared back out) goes back to auto-generating —
            // anything else counts as a deliberate override.
            row.nameDirty = value.trim() !== '';
        }

//@fn onPromoOfferTypeChange
function onPromoOfferTypeChange() {
            const type = document.getElementById('offer-type-select').value;
            ['bogo', 'percent', 'flat', 'bundle'].forEach(t => {
                document.getElementById(`offer-fields-${t}`).style.display = t === type ? 'block' : 'none';
            });
        }

//@fn onRecordBillUpfrontChange
function onRecordBillUpfrontChange() {
            const val = parseFloat(document.getElementById('record-bill-upfront').value) || 0;
            document.getElementById('record-bill-upfront-method-row').style.display = val > 0 ? 'block' : 'none';
        }

//@fn onReturnQtyChanged
function onReturnQtyChanged() {
            autofillExchangeCreditValue();
        }

//@fn openAddCustomerModal
function openAddCustomerModal() {
            document.getElementById('add-customer-name-input').value = '';
            document.getElementById('add-customer-phone-input').value = '';
            document.getElementById('add-customer-error').textContent = '';
            document.getElementById('add-customer-modal').style.display = 'flex';
        }

//@fn openAddDebtModal
function openAddDebtModal(debtId) {
            const d = debtId ? debts.find(x => x.id === debtId) : null;
            document.getElementById('debt-modal-title').textContent = d ? '✏️ Edit Debt' : '➕ Add Debt';
            document.getElementById('debt-modal-id').value = d ? d.id : '';
            document.getElementById('debt-modal-name').value = d ? d.customerName : '';
            document.getElementById('debt-modal-phone').value = d ? (d.phone || '') : '';
            document.getElementById('debt-modal-amount').value = d ? d.amount : '';
            document.getElementById('debt-modal-notes').value = d ? (d.notes || '') : '';
            document.getElementById('debt-modal-msg').textContent = '';
            document.getElementById('debt-modal').style.display = 'flex';
        }

//@fn openAddPromoOffer
function openAddPromoOffer() {
            document.getElementById('promo-offer-modal-title').textContent = '+ New Offer';
            resetPromoOfferModalFields();
            document.getElementById('promo-offer-modal').style.display = 'flex';
        }

//@fn openAdhocSaleModal
function openAdhocSaleModal(prefillName, prefillPrice) {
            document.getElementById('adhoc-sale-name-input').value = prefillName || '';
            document.getElementById('adhoc-sale-price-input').value = prefillPrice ? prefillPrice.toFixed(2) : '';
            document.getElementById('adhoc-sale-qty-input').value = '1';
            // Opened from an out-of-stock item, borrowing is almost certainly
            // why — pre-check it so the borrowed-from fields are right there,
            // rather than making that a second tap every time.
            const borrowed = !!prefillName;
            document.getElementById('adhoc-sale-borrowed-toggle').checked = borrowed;
            document.getElementById('adhoc-borrowed-fields').style.display = borrowed ? 'block' : 'none';
            document.getElementById('adhoc-borrowed-party-input').value = '';
            document.getElementById('adhoc-borrowed-amount-input').value = prefillPrice ? prefillPrice.toFixed(2) : '';
            document.getElementById('adhoc-sale-modal-error').textContent = '';
            document.getElementById('adhoc-sale-modal').style.display = 'flex';
        }

//@fn openAttendanceClockModal
function openAttendanceClockModal(personKey) {
            const roster = attendanceRosterList();
            const person = roster.find(p => p.key === personKey);
            if (!person) return;
            pendingAttendancePersonKey = personKey;
            const entry = attendanceTodayEntry(personKey);
            const clockingIn = !entry || entry.clockOut;
            document.getElementById('attendance-clock-modal-title').textContent = clockingIn ? `🕐 Clock In — ${person.name}` : `🕐 Clock Out — ${person.name}`;
            document.getElementById('attendance-clock-confirm-btn').textContent = clockingIn ? 'Clock In' : 'Clock Out';
            document.getElementById('attendance-clock-person-key').value = personKey;
            document.getElementById('attendance-clock-pin-row').style.display = (clockingIn && person.hasPin) ? 'block' : 'none';
            document.getElementById('attendance-clock-pin-input').value = '';
            document.getElementById('attendance-clock-msg').textContent = '';
            document.getElementById('attendance-clock-modal').style.display = 'flex';
        }

//@fn openBoxToPieces
function openBoxToPieces(code) {
            const product = inventory.find(p => p.code === code);
            if (!product || !product.dualUnit) return;
            if ((product.qty || 0) < 1) {
                showToast(`No boxes of "${product.name}" left to open.`, true);
                return;
            }
            product.qty -= 1;
            logStockMovement(product.code, product.name, -1, 'Box opened', 'qty');
            const openedPieces = product.unitsPerBox || 1;
            product.pieceQty = (product.pieceQty || 0) + openedPieces;
            logStockMovement(product.code, product.name, openedPieces, 'Box opened', 'pieceQty');
            safeSetItem('pos_inventory', JSON.stringify(inventory));
            queuePush();
            renderInventoryTable();
            renderNotifications();
            showToast(`Opened 1 box of "${product.name}" — ${product.unitsPerBox} pieces added to loose stock.`);
        }

//@fn openCartTotalQuoteEditor
function openCartTotalQuoteEditor() {
            if (Object.keys(currentCart).length === 0) return;
            cartTotalQuoteEditing = true;
            renderCart();
        }

//@fn openCashDrawer
async function openCashDrawer(isManualTest) {
            const statusEl = document.getElementById('cash-drawer-status');
            const setStatus = (msg, isError) => {
                if (!isManualTest || !statusEl) return;
                statusEl.className = isError ? 'settings-msg error' : 'settings-msg success';
                statusEl.textContent = msg;
            };

            try {
                if (printerMode === 'bluetooth' && btPrinterCharacteristic) {
                    await sendBytesViaBluetooth(buildDrawerKickBytes());
                    setStatus('Drawer kick sent over Bluetooth.');
                } else if (printerMode === 'usb' && usbPrinterDevice && usbPrinterEndpoint !== null) {
                    await sendBytesViaUSB(buildDrawerKickBytes());
                    setStatus('Drawer kick sent over USB.');
                } else if (printerMode === 'system') {
                    if (isManualTest) {
                        printSystemDrawerKickTest();
                        setStatus('Sent a system print job with the drawer-kick command riding along. If the drawer doesn’t open, set your printer’s driver to "Generic / Text Only" (raw) mode.');
                    }
                    // Automatic case (a real sale): the kick command is embedded directly
                    // inside that receipt's own print job by renderReceipt() — there's
                    // nothing extra to send here, since printing it twice would mean two
                    // separate system print dialogs for one sale.
                } else {
                    const msg = 'No Bluetooth/USB printer connected — the cash drawer can only be triggered through one of those (see the note above).';
                    if (isManualTest) showToast(msg, true);
                    setStatus(msg, true);
                }
            } catch (e) {
                const msg = `Could not open the drawer: ${e.message}`;
                if (isManualTest) showToast(msg, true);
                setStatus(msg, true);
            }
        }

//@fn openContractReturnModal
function openContractReturnModal(contractId) {
            const contract = contracts.find(c => c.id === contractId);
            if (!contract) return;
            const items = Object.values(contract.items || {}).filter(it => ((it.qtyCarried || 0) - (it.qtyReturned || 0) - (it.qtySettled || 0)) > 0.004);
            if (items.length === 0) {
                showToast('Nothing currently held on this contract to return.', true);
                return;
            }
            pendingContractReturnId = contractId;
            document.getElementById('contract-return-summary').textContent = `${contract.name} — ${contract.type === 'wholesale' ? 'Wholesale' : 'Retail'} contract`;
            document.getElementById('contract-return-modal-error').textContent = '';
            document.getElementById('contract-return-rows').innerHTML = items.map(it => {
                const held = Math.max(0, (it.qtyCarried || 0) - (it.qtyReturned || 0) - (it.qtySettled || 0));
                return `
                <div class="form-group" style="display:flex; align-items:center; gap:8px;">
                    <span style="flex:2;">${escapeHtml(it.name)}<br><span style="font-size:12px; color:#7f8c8d;">${held} held</span></span>
                    <input type="number" min="0" max="${held}" step="1" placeholder="0" style="flex:1;" data-code="${escapeHtml(it.code)}" id="return-qty-${escapeQuotes(it.code)}">
                </div>`;
            }).join('');
            document.getElementById('contract-return-modal').style.display = 'flex';
        }

//@fn openCustomerDisplayWindow
function openCustomerDisplayWindow() {
            openCustomerDisplayOnSecondScreen();
        }

//@fn openDebtPaymentModal
function openDebtPaymentModal(debtId) {
            const d = debts.find(x => x.id === debtId);
            if (!d) return;
            pendingDebtPaymentId = debtId;
            document.getElementById('debt-payment-debt-id').value = debtId;
            document.getElementById('debt-payment-balance-line').textContent = `${d.customerName} — ${money(debtBalance(d))} still owed (of ${money(d.amount)} total)`;
            document.getElementById('debt-payment-amount').value = '';
            document.getElementById('debt-payment-method').value = 'Cash';
            document.getElementById('debt-payment-msg').textContent = '';
            document.getElementById('debt-payment-modal').style.display = 'flex';
        }

//@fn openDeliveryOrderModal
function openDeliveryOrderModal(saleId, source) {
            const record = findDeliveryRecord(saleId, source);
            if (!record) return;
            const dd = record.deliveryDetails || {};
            const agent = record.deliveryAgentId ? findDeliveryAgentById(record.deliveryAgentId) : null;
            const itemsHtml = (record.items || []).map(it => `<div style="display:flex; justify-content:space-between; font-size:13px;"><span>${escapeHtml(it.name)} x${it.qty}</span><span>${money(it.qty * it.price)}</span></div>`).join('');
            document.getElementById('delivery-order-modal-title').textContent = `Order ${record.refNumber}`;
            document.getElementById('delivery-order-modal-body').innerHTML = `
                <p><b>Client:</b> ${escapeHtml(dd.clientName || record.customerName || '—')}</p>
                <p><b>Address:</b> ${escapeHtml(dd.address || '—')}</p>
                ${dd.phone ? `<p><b>Phone:</b> ${escapeHtml(dd.phone)}</p>` : ''}
                <p><b>Agent:</b> ${agent ? escapeHtml(agent.name) : '—'}</p>
                <p><b>Status:</b> <span class="delivery-status-pill ${record.deliveryStatus || 'assigned'}">${statusLabelFor(record.deliveryStatus)}</span></p>
                <hr class="settings-divider">
                ${itemsHtml}
                <hr class="settings-divider">
                <p><b>Total:</b> ${money(record.total)}</p>
                <p><b>Payment:</b> ${dd.pod && bills.some(b => b.id === record.id) ? 'Unpaid — Pay on Delivery' : (record.paymentMethod || '').toUpperCase()}</p>
            `;
            document.getElementById('delivery-order-modal').style.display = 'flex';
        }

//@fn openDeliveryPaymentModal
function openDeliveryPaymentModal(saleId) {
            const bill = bills.find(b => b.id === saleId);
            if (!bill) { showToast('Could not find that order — it may already be settled.', true); renderDeliveriesTab(); return; }
            pendingDeliveryPaymentSaleId = saleId;
            const outstanding = Math.max(0, (bill.total || 0) - (bill.amountPaid || 0));
            document.getElementById('delivery-payment-summary').textContent = `${(bill.deliveryDetails && bill.deliveryDetails.clientName) || bill.customerName || 'Customer'} — ${money(outstanding)} due`;
            document.getElementById('delivery-payment-mpesa-code-input').value = '';
            document.getElementById('delivery-payment-split-cash-input').value = '';
            document.getElementById('delivery-payment-split-mpesa-input').value = '';
            document.getElementById('delivery-payment-error').textContent = '';
            setDeliveryPaymentCaptureMethod('cash');
            document.getElementById('delivery-payment-modal').style.display = 'flex';
        }

//@fn openEditPromoOffer
function openEditPromoOffer(id) {
            const offer = offers.find(o => o.id === id);
            if (!offer) return;
            resetPromoOfferModalFields();
            document.getElementById('promo-offer-modal-title').textContent = '✏️ Edit Offer';
            document.getElementById('offer-edit-id').value = offer.id;
            document.getElementById('offer-name-input').value = offer.name || '';
            document.getElementById('offer-type-select').value = offer.type;
            onPromoOfferTypeChange();
            if (offer.type === 'bogo') {
                document.getElementById('offer-bogo-buyqty').value = offer.buyQty || '';
                document.getElementById('offer-bogo-freeqty').value = offer.freeQty || '';
                document.getElementById('offer-bogo-discount-pct').value = offer.freeDiscountPercent == null ? 100 : offer.freeDiscountPercent;
            } else if (offer.type === 'percent') {
                document.getElementById('offer-percent-input').value = offer.percentOff || '';
            } else if (offer.type === 'flat') {
                document.getElementById('offer-flat-amount').value = offer.flatAmount || '';
                document.getElementById('offer-flat-minqty').value = offer.minQty || 1;
            } else if (offer.type === 'bundle') {
                document.getElementById('offer-bundle-qty').value = offer.bundleQty || '';
                document.getElementById('offer-bundle-price').value = offer.bundlePrice || '';
            }
            setPromoOfferScope(offer.scope || 'all');
            const selectedCodes = (offer.targets || []).map(t => t.kind === 'category' ? `category:${t.category}` : `code:${t.code}`);
            renderPromoOfferTargetCategories(selectedCodes);
            renderPromoOfferTargetProducts('', selectedCodes);
            document.getElementById('promo-offer-modal').style.display = 'flex';
        }

//@fn openLicenseWhatsapp
function openLicenseWhatsapp() {
            const msg = `Hi, my mydukapos link (${window.location.href}) no longer works — it looks like it was removed. Could you help reinstate it or set me up with a new one?`;
            window.open(`https://wa.me/254791598506?text=${encodeURIComponent(msg)}`, '_blank');
        }

//@fn openOfferModal
function openOfferModal(code) {
            const product = inventory.find(p => p.code === code);
            if (!product) return;
            pendingOfferCode = code;
            document.getElementById('offer-modal-item-name').textContent = product.name;
            document.getElementById('offer-modal-error').textContent = '';
            const hasOffer = isOfferActive(product);
            setOfferType(hasOffer ? product.offer.type : 'percent');
            document.getElementById('offer-value-input').value = hasOffer ? product.offer.value : '';
            document.getElementById('offer-duration-select').value = '24';
            document.getElementById('offer-custom-date-input').style.display = 'none';
            document.getElementById('offer-remove-btn').style.display = hasOffer ? 'inline-block' : 'none';
            document.getElementById('offer-modal').style.display = 'flex';
        }

//@fn openPoleDisplayPort
async function openPoleDisplayPort(port) {
            await port.open({ baudRate: 9600 }); // 9600 8N1 — the near-universal factory default for these units
            poleDisplayPort = port;
            poleDisplayWriter = port.writable.getWriter();
            port.addEventListener('disconnect', () => {
                poleDisplayPort = null;
                poleDisplayWriter = null;
                const el = document.getElementById('pole-display-status');
                if (el) { el.className = 'settings-msg error'; el.textContent = 'Disconnected. Tap Connect to reconnect.'; }
            });
        }

//@fn openRecordBillModal
function openRecordBillModal() {
            document.getElementById('record-bill-customer-name').value = '';
            document.getElementById('record-bill-phone').value = '';
            document.getElementById('record-bill-description').value = '';
            document.getElementById('record-bill-amount').value = '';
            document.getElementById('record-bill-due-date').value = '';
            document.getElementById('record-bill-upfront').value = '';
            document.getElementById('record-bill-upfront-method-row').style.display = 'none';
            document.getElementById('record-bill-error').textContent = '';
            document.getElementById('record-bill-modal').style.display = 'flex';
        }

//@fn openRecordPastSaleModal
function openRecordPastSaleModal() {
            selectedPastSaleItem = null;
            const now = new Date();
            document.getElementById('past-sale-date-input').value = todayDateString();
            document.getElementById('past-sale-time-input').value = now.toTimeString().slice(0, 5);
            document.getElementById('past-sale-item-search').value = '';
            document.getElementById('past-sale-item-results').style.display = 'none';
            document.getElementById('past-sale-selected-item').textContent = '';
            document.getElementById('past-sale-qty-input').value = '1';
            document.getElementById('past-sale-price-input').value = '';
            document.getElementById('past-sale-error').textContent = '';
            ['past-sale-mpesa-code-input', 'past-sale-mpesa-name-input', 'past-sale-card-ref-input', 'past-sale-split-cash-input', 'past-sale-split-mpesa-input', 'past-sale-bill-name-input', 'past-sale-bill-phone-input', 'past-sale-bill-paid-input']
                .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
            const sel = document.getElementById('past-sale-payment-select'); if (sel) sel.value = 'cash';
            pastSalePaymentChanged();
            document.getElementById('record-past-sale-modal').style.display = 'flex';
        }

//@fn openSettingsSection
function openSettingsSection(sectionId) {
            const settingsBtn = document.getElementById('settings-tab-btn');
            if (settingsBtn) settingsBtn.click();
            showSettingsSection(sectionId);
        }

//@fn openVariantsModal
function openVariantsModal(code) {
            const product = inventory.find(p => p.code === code);
            if (!product || !Array.isArray(product.variants)) return;
            variantsModalCode = code;
            variantsModalDraft = product.variants.map(v => ({ ...v }));
            document.getElementById('variants-view-modal-title').textContent = `🔀 Variants — ${product.name}`;
            document.getElementById('variants-view-modal-error').textContent = '';
            renderVariantsModalList();
            document.getElementById('variants-view-modal').style.display = 'flex';
        }

//@fn openWebAuthnDb
function openWebAuthnDb() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(WEBAUTHN_DB_NAME, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(WEBAUTHN_STORE)) {
                        db.createObjectStore(WEBAUTHN_STORE, { keyPath: 'credentialId' });
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }

//@fn padPoleLine
function padPoleLine(text, width) {
            return String(text || '').slice(0, width).padEnd(width, ' ');
        }

//@fn parseHexBytes
function parseHexBytes(str) {
            return (str || '').trim().split(/\s+/).filter(Boolean).map(h => {
                const n = parseInt(h, 16);
                if (isNaN(n) || n < 0 || n > 255 || !/^[0-9a-f]{1,2}$/i.test(h)) {
                    throw new Error(`"${h}" isn’t a valid hex byte (00–FF).`);
                }
                return n;
            });
        }

//@fn parseQtyInput
function parseQtyInput(raw) {
            if (typeof raw === 'number') return isFinite(raw) ? raw : NaN;
            let s = String(raw == null ? '' : raw).trim().toLowerCase();
            if (!s) return NaN;

            // Strip any trailing unit text ("2 kg", "1/2 litre") — the unit is
            // already known from the row's own selector.
            s = s.replace(/[a-z]+\.?$/i, '').trim();
            if (!s) return NaN;

            // Expand unicode fraction glyphs into "a/b", inserting a space after a
            // leading whole number so "1½" becomes "1 1/2".
            for (const [glyph, val] of Object.entries(UNICODE_FRACTIONS)) {
                if (s.includes(glyph)) {
                    const parts = s.split(glyph);
                    const wholePart = parseFloat(parts[0]) || 0;
                    const result = wholePart + val;
                    return isFinite(result) ? result : NaN;
                }
            }

            // "1-1/4" is a common shorthand; normalise it to "1 1/4".
            s = s.replace(/^(\d+)\s*-\s*(\d+\s*\/\s*\d+)$/, '$1 $2');

            // Mixed number: "1 1/4"
            const mixed = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
            if (mixed) {
                const den = parseInt(mixed[3], 10);
                if (!den) return NaN;
                return parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / den;
            }

            // Plain fraction: "3/4"
            const simple = s.match(/^(\d+)\s*\/\s*(\d+)$/);
            if (simple) {
                const den = parseInt(simple[2], 10);
                if (!den) return NaN;
                return parseInt(simple[1], 10) / den;
            }

            // Thousands-grouping vs. decimal comma/space — "1,200" and "1 200"
            // both mean twelve hundred to someone counting stock; naively
            // swapping the comma for a decimal point (below) used to turn
            // "1,200" into 1.2 and "12,000" into 12, silently wiping out a
            // stock take count to a tiny fraction of what was typed. Only
            // treat a comma as a decimal separator when it's a single comma
            // followed by 1-2 digits ("0,25" on some keyboards) — a proper
            // 3-digit grouping (optionally repeated, e.g. "1,200,000") or a
            // space-grouped number is a whole-number count instead.
            if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
            else if (/^\d{1,3}( \d{3})+$/.test(s)) s = s.replace(/ /g, '');
            else if (!/^\d+,\d{1,2}$/.test(s)) s = s.replace(/,/g, ''); // any other stray comma — drop rather than misread as a decimal point

            // Plain decimal, with either separator ("0,25" on some keyboards).
            const n = parseFloat(s.replace(',', '.'));
            return isFinite(n) ? n : NaN;
        }

//@fn performBulkDeclareOpeningStock
function performBulkDeclareOpeningStock() {
            const stocked = inventory.filter(p => isStockedProduct(p));
            const undeclared = stocked.filter(p => !p.openingStock);
            const date = todayLocalDateStr();
            const setBy = activeServerName();
            undeclared.forEach(p => {
                p.openingStock = { qty: p.qty || 0, costPrice: p.wholesalePrice || 0, date, setBy };
            });
            safeSetItem('pos_inventory', JSON.stringify(inventory));
            queuePush();
            renderInventoryTable();
            renderStockValuationSummary();
            showToast(`Opening stock declared for ${undeclared.length} item(s).`);
        }

//@fn performCartPriceChange
function performCartPriceChange(key, price) {
            const line = currentCart[key];
            if (!line) return;
            line.price = price;
            renderCart();
        }

//@fn cartLineMinimumPrice
// The lowest unit price staff may set on one cart line, 0 if none applies.
// A variant line uses that variant's own minimum; a variant saved before
// per-variant minimums existed has none of its own, so it falls back to the
// parent item's. A loose-piece line (dual-unit piece mode) has no minimum:
// the minimum is set against the box/whole-unit price, and applying it to a
// piece price would block every piece sale. Items not in this shop's own
// inventory (e.g. a cross-branch line) have no local minimum to apply.
function cartLineMinimumPrice(line) {
            if (!line || line.isCrossBranch) return 0;
            // Water (Aqua) keeps its items in `products` and has no way to set
            // a minimum price yet, so there is nothing to enforce there.
            if (typeof inventory === 'undefined' || !Array.isArray(inventory)) return 0;
            const product = inventory.find(p => p.code === line.code);
            if (!product) return 0;
            if (line.variantId) {
                if (line.variantSaleMode === 'piece') return 0;
                const variant = (product.variants || []).find(v => v.id === line.variantId);
                if (!variant) return 0;
                const own = variant.minimumPrice;
                const hasOwn = own !== undefined && own !== null && own !== '';
                return Math.max(0, Number(hasOwn ? own : product.minimumPrice) || 0);
            }
            if (line.saleMode === 'piece') return 0;
            return Math.max(0, Number(product.minimumPrice) || 0);
        }

//@fn cartTotalBelowMinimumMessage
// A custom total quote rescales every line by the same ratio, so the lowest
// total that keeps every line at or above its own minimum is the current
// total times the largest (minimum / current price) ratio across the lines.
// Returns the refusal message if newTotal is below that, otherwise null.
function cartTotalBelowMinimumMessage(newTotal) {
            const entries = Object.values(currentCart);
            const itemsTotal = entries.reduce((sum, l) => sum + l.price * l.qty, 0);
            if (itemsTotal <= 0) return null;
            let ratio = 0;
            let blocker = null;
            entries.forEach((l) => {
                const min = cartLineMinimumPrice(l);
                if (min > 0 && l.price > 0 && l.qty > 0 && min / l.price > ratio) { ratio = min / l.price; blocker = l; }
            });
            if (!blocker) return null;
            const floor = Math.ceil(itemsTotal * ratio);
            if (newTotal >= floor - 0.005) return null;
            return `That total is too low: "${blocker.name}" has a minimum price of ${money(cartLineMinimumPrice(blocker))}. The lowest total you can quote for this sale is ${money(floor)}.`;
        }

//@fn performCartTotalQuote
function performCartTotalQuote(newTotal) {
            const entries = Object.values(currentCart);
            if (entries.length === 0) return;
            const itemsTotal = entries.reduce((sum, l) => sum + l.price * l.qty, 0);
            if (itemsTotal <= 0) { showToast('Cannot quote a total on a cart with no priced items.', true); renderCart(); return; }
            const belowMin = cartTotalBelowMinimumMessage(newTotal);
            if (belowMin) { showToast(belowMin, true); renderCart(); return; }

            const scale = newTotal / itemsTotal;
            let allocated = 0;
            entries.forEach((l, idx) => {
                if (idx === entries.length - 1) {
                    const remaining = round2(newTotal - allocated);
                    l.price = l.qty > 0 ? round2(remaining / l.qty) : l.price;
                } else {
                    l.price = round2(l.price * scale);
                    allocated = round2(allocated + l.price * l.qty);
                }
            });
            renderCart();
            showToast(`Sale re-quoted at ${money(newTotal)} — unit prices recalculated to match.`);
        }

//@fn performEditOpeningStock
function performEditOpeningStock(code) {
            const product = inventory.find(p => p.code === code);
            if (!product || !product.openingStock) { showToast('Could not find that item\'s opening stock.', true); return; }

            const qtyRaw = prompt(`Corrected opening stock quantity for "${product.name}" (in ${unitLabel(product.unit)}):`, String(product.openingStock.qty || 0));
            if (qtyRaw === null) return;
            const qty = parseQtyInput(qtyRaw);
            if (isNaN(qty) || qty < 0) { showToast('Enter a valid quantity.', true); return; }

            const costRaw = prompt(`Corrected cost price per ${unitLabel(product.unit)} at that time (KES):`, String(product.openingStock.costPrice || 0));
            if (costRaw === null) return;
            const costPrice = parseFloat(costRaw);
            if (isNaN(costPrice) || costPrice < 0) { showToast('Enter a valid cost price.', true); return; }

            const dateRaw = prompt('Date (YYYY-MM-DD):', product.openingStock.date || todayLocalDateStr());
            if (dateRaw === null) return;
            const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw.trim()) ? dateRaw.trim() : product.openingStock.date;

            product.openingStock = { qty, costPrice, date, setBy: product.openingStock.setBy, editedBy: activeServerName(), editedAt: Date.now() };
            safeSetItem('pos_inventory', JSON.stringify(inventory));
            queuePush();
            renderInventoryTable();
            renderStockValuationSummary();
            showToast(`Opening stock corrected for "${product.name}".`);
        }

//@fn performResetExceptInventory
function performResetExceptInventory() {
            const salesCleared = salesLog.length, billsCleared = bills.length;
            salesLog = [];
            bills = [];
            stockMovementLog = [];
            let rolledBack = 0;
            inventory.forEach(p => {
                if (p.openingStock) {
                    p.qty = p.openingStock.qty || 0;
                    rolledBack++;
                }
            });
            safeSetItem('pos_sales_log', JSON.stringify(salesLog));
            try { if (typeof window.salesJournalForget === 'function') window.salesJournalForget('reset (all sales cleared, stock kept)'); } catch (e) { /* bookkeeping */ }
            safeSetItem('pos_bills', JSON.stringify(bills));
            safeSetItem('pos_stock_movement_log', JSON.stringify(stockMovementLog));
            safeSetItem('pos_inventory', JSON.stringify(inventory));
            queuePush();
            renderDailySales();
            renderBillsTab();
            renderInventoryTable();
            renderStockReport();
            renderStockValuationSummary();
            showToast(`Cleared ${salesCleared} sale(s) and ${billsCleared} bill(s). ${rolledBack} item(s) rolled back to their opening stock.`);
        }

//@fn performSupplierGasExchange
function performSupplierGasExchange() {
            // send    — empties leave for the supplier: Empty -n, Away +n
            // receive — refilled cylinders come back: Full +n, Away -n
            // return  — swapped empties for full ones on the spot: Empty -n, Full +n
            const msgEl = document.getElementById('gas-supplier-msg');
            const fullCode = document.getElementById('gas-supplier-variant-select').value;
            const direction = document.getElementById('gas-supplier-direction').value;
            const qty = Math.max(1, Math.round(parseFloat(document.getElementById('gas-supplier-qty').value) || 1));
            const fail = (m) => { msgEl.className = 'settings-msg error'; msgEl.textContent = m; };
            const full = inventory.find(p => p.code === fullCode);
            if (!full) { fail('Choose a cylinder size first.'); return; }
            const empty = inventory.find(p => p.code === full.gasPairCode);
            if (!empty) { fail('Could not find the matching Empty item.'); return; }
            const label = gasLabelOf(full);
            if (direction !== 'receive' && (empty.qty || 0) < qty) { fail(`Only ${empty.qty || 0} empty ${label} on hand.`); return; }
            if (direction === 'receive' && (full.gasAtSupplier || 0) < qty) { fail(`Only ${full.gasAtSupplier || 0} ${label} are with the supplier.`); return; }
            if (direction === 'send') { empty.qty = (empty.qty || 0) - qty; full.gasAtSupplier = (full.gasAtSupplier || 0) + qty; }
            else if (direction === 'receive') { full.qty = (full.qty || 0) + qty; full.gasAtSupplier = (full.gasAtSupplier || 0) - qty; }
            else { empty.qty = (empty.qty || 0) - qty; full.qty = (full.qty || 0) + qty; }
            gasSupplierHistory.unshift({ id: genSaleId(), timestamp: new Date().toISOString(), label, direction, qty });
            gasSupplierHistory = gasSupplierHistory.slice(0, 30);
            safeSetItem('pos_gas_supplier_history', JSON.stringify(gasSupplierHistory));
            gasSaveInventory();
            msgEl.className = 'settings-msg success';
            msgEl.textContent = { send: `Recorded ${qty} empty ${label} sent to the supplier.`, receive: `Recorded ${qty} refilled ${label} received.`, return: `Recorded ${qty} ${label}: empties swapped for full ones.` }[direction];
        }

//@fn persistPrintRoutingRules
async function persistPrintRoutingRules() {
            try {
                await fetch(apiUrl('/api/print-relay'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'saveRules', rules: printRoutingRules }),
                });
            } catch (e) {
                showToast(netErrText('Could not save routing rules'), true);
            }
        }

//@fn pickPhoneForField
async function pickPhoneForField(btn) {
            if (!('contacts' in navigator && 'ContactsManager' in window)) {
                showToast("Importing from phonebook isn't supported on this device/browser yet — it works on Android Chrome. You can still type the number in.", true);
                return;
            }
            const input = btn.previousElementSibling;
            if (!input) return;

            let picked;
            try {
                picked = await navigator.contacts.select(['tel'], { multiple: false });
            } catch (e) {
                // User cancelled the picker, or denied the permission prompt.
                return;
            }
            if (!picked || picked.length === 0) return;

            const contact = picked[0];
            const rawPhone = (contact.tel && contact.tel.length) ? contact.tel[0] : '';
            if (!rawPhone) {
                showToast('That contact has no phone number saved.', true);
                return;
            }

            input.value = formatPickedPhone(rawPhone);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.focus();
        }

//@fn populateServerFilter
function populateServerFilter() {
            const select = document.getElementById('report-server-filter');
            if (!select) return;
            const previousValue = select.value;

            const names = new Set();
            staff.forEach(s => names.add(s.name));
            salesLog.forEach(sale => { if (sale.servedBy) names.add(sale.servedBy); });

            const sortedNames = Array.from(names).sort((a, b) => a.localeCompare(b));
            select.innerHTML = '<option value="">All Servers</option>' +
                sortedNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');

            if (sortedNames.includes(previousValue)) select.value = previousValue;
        }

//@fn previewBarcode
function previewBarcode() {
            const value = sanitizeBarcodeValue(document.getElementById('barcode-value-input').value);
            const preview = document.getElementById('barcode-live-preview');
            if (!value) {
                preview.innerHTML = `<p style="color:#95a5a6; font-size:13px;">Enter or generate a value to preview.</p>`;
                return;
            }
            preview.innerHTML = renderCode39SVG(value, { height: 60 }) +
                `<div style="margin-top:6px; font-family:monospace; letter-spacing:2px;">${escapeHtml(value)}</div>`;
        }

//@fn printAttendanceSheet
function printAttendanceSheet() {
            const fromEl = document.getElementById('attendance-history-from');
            const toEl = document.getElementById('attendance-history-to');
            const from = fromEl && fromEl.value ? fromEl.value : todayDateString();
            const to = toEl && toEl.value ? toEl.value : from;
            const list = attendanceLog
                .filter(e => { const k = dateKey(new Date(e.clockIn)); return k >= from && k <= to; })
                .sort((a, b) => a.personName.localeCompare(b.personName) || new Date(a.clockIn) - new Date(b.clockIn));
            const rows = list.map(e => {
                const hours = e.clockOut ? ((new Date(e.clockOut) - new Date(e.clockIn)) / 3600000) : ((Date.now() - new Date(e.clockIn)) / 3600000);
                const expected = expectedTimesForPersonKey(e.personKey);
                const inDeviation = attendanceDeviationLabel(e.clockIn, expected.clockIn);
                const outDeviation = e.clockOut ? attendanceDeviationLabel(e.clockOut, expected.clockOut) : '';
                const devTxt = (label) => label ? ` (${label})` : '';
                return `<tr><td>${escapeHtml(e.personName)}</td><td>${new Date(e.clockIn).toLocaleString('en-GB')}${devTxt(inDeviation)}</td><td>${e.clockOut ? new Date(e.clockOut).toLocaleString('en-GB') + devTxt(outDeviation) : 'Still in'}</td><td style="text-align:right;">${formatHours(hours)}</td></tr>`;
            }).join('');
            const win = window.open('', '_blank');
            win.document.write(`<html><head><title>Attendance Sheet</title><style>
                body{font-family:Arial,sans-serif; padding:20px;} table{width:100%; border-collapse:collapse;}
                th,td{border-bottom:1px solid #ddd; padding:6px 8px; font-size:13px; text-align:left;}
                h2{margin-bottom:4px;}
            </style></head><body>
            <h2>${escapeHtml(businessName || 'Attendance Sheet')}</h2>
            <div>${from === to ? from : `${from} — ${to}`}</div>
            <table><thead><tr><th>Name</th><th>Clock In</th><th>Clock Out</th><th style="text-align:right;">Hours</th></tr></thead><tbody>${rows}</tbody></table>
            </body></html>`);
            win.document.close();
            win.focus();
            setTimeout(() => win.print(), 300);
        }

//@fn printBarcodeSheet
function printBarcodeSheet() {
            const checked = document.querySelectorAll('#saved-barcodes-table input[type="checkbox"]:checked');
            let selected = [...checked].map(cb => savedBarcodes.find(b => b.id === cb.dataset.id)).filter(Boolean);
            if (selected.length === 0) selected = savedBarcodes;
            renderAndPrintBarcodes(selected);
        }

//@fn printDebtsStatement
function printDebtsStatement() {
            const open = debts.filter(d => debtBalance(d) > 0.005);
            const rows = open.map(d => `<tr><td>${escapeHtml(d.customerName)}</td><td>${escapeHtml(d.phone || '—')}</td><td style="text-align:right;">${money(debtBalance(d))}</td></tr>`).join('');
            const total = open.reduce((s, d) => s + debtBalance(d), 0);
            const win = window.open('', '_blank');
            win.document.write(`<html><head><title>Debts Statement</title><style>
                body{font-family:Arial,sans-serif; padding:20px;} table{width:100%; border-collapse:collapse;}
                th,td{border-bottom:1px solid #ddd; padding:6px 8px; font-size:13px; text-align:left;}
                h2{margin-bottom:4px;} .tot{font-weight:bold; font-size:15px; margin-top:10px;}
            </style></head><body>
            <h2>${escapeHtml(businessName || 'Debts Statement')}</h2>
            <div>${new Date().toLocaleString('en-GB')}</div>
            <table><thead><tr><th>Customer</th><th>Phone</th><th style="text-align:right;">Balance (KES)</th></tr></thead><tbody>${rows}</tbody></table>
            <div class="tot">Total outstanding: ${money(total)}</div>
            </body></html>`);
            win.document.close();
            win.focus();
            setTimeout(() => win.print(), 300);
        }

//@fn printHTMLDirect
function printHTMLDirect(bodyHtml, extraCss) {
            const area = document.getElementById('aqua-pos-print-area');
            if (!area) return;
            area.innerHTML = (extraCss ? `<style>${extraCss}</style>` : '') + bodyHtml;
            document.body.classList.add('printing-adhoc');
            let finished = false;
            const finishUp = () => {
                if (finished) return;
                finished = true;
                window.removeEventListener('afterprint', finishUp);
                document.body.classList.remove('printing-adhoc');
                area.innerHTML = '';
            };
            window.addEventListener('afterprint', finishUp);
            window.print();
            setTimeout(finishUp, 5000);
        }

//@fn printItemSalesRecordFromModal
function printItemSalesRecordFromModal() {
            if (inventoryEditModalCode) printItemSalesRecord(inventoryEditModalCode);
        }

//@fn printKitchenTicket
function printKitchenTicket() {
            const text = lastKitchenTicketText || document.getElementById('kitchen-ticket-body').innerText;
            if (!text.trim()) {
                showToast('Nothing to print yet.', true);
                return;
            }
            return queuePrintJob(() => printKitchenTicketManualJob(text));
        }

//@fn printKitchenTicketManualJob
async function printKitchenTicketManualJob(text) {
            if (printerMode === 'bluetooth') {
                if (!btPrinterCharacteristic) {
                    showToast('Bluetooth printer not connected — using the system print dialog instead.', true);
                    await printKitchenTicketViaSystemDialog();
                    return;
                }
                if (await printViaBluetooth(text)) closeKitchenTicket();
                return;
            }
            if (printerMode === 'usb') {
                if (!usbPrinterDevice || usbPrinterEndpoint === null) {
                    showToast('USB printer not connected — using the system print dialog instead.', true);
                    await printKitchenTicketViaSystemDialog();
                    return;
                }
                if (await printViaUSB(text)) closeKitchenTicket();
                return;
            }
            await printKitchenTicketViaSystemDialog();
        }

//@fn printOneBarcode
function printOneBarcode(id) {
            const entry = savedBarcodes.find(b => b.id === id);
            if (entry) renderAndPrintBarcodes([entry]);
        }

//@fn printReceiptInNewWindow
function printReceiptInNewWindow() {
            return new Promise((resolve) => {
                try { fitReceiptGrids(); } catch (e) { /* the estimate stands */ }   // zip 144: exactly `cols` characters across the printable width
                buildSystemPrintCopies();
                setPrintMode('receipt');
                let finished = false;
                const finishUp = () => {
                    if (finished) return;
                    finished = true;
                    window.removeEventListener('afterprint', finishUp);
                    resolve();
                };
                window.addEventListener('afterprint', finishUp);
                window.print();
                // Safety net in case 'afterprint' never fires on some browsers.
                setTimeout(finishUp, 5000);
            });
        }

//@fn printRelayHasRealPrinter
function printRelayHasRealPrinter() {
            return (printerMode === 'bluetooth' && btPrinterCharacteristic) || (printerMode === 'usb' && usbPrinterDevice);
        }

//@fn printReportInNewWindow
function printReportInNewWindow() {
            return new Promise((resolve) => {
                const logoBlock = document.getElementById('report-logo-block');
                if (logoBlock) {
                    if (receiptShowLogo && receiptLogoData) {
                        document.getElementById('report-logo-img').src = receiptLogoData;
                        logoBlock.style.display = 'block';
                    } else {
                        logoBlock.style.display = 'none';
                    }
                }
                setPrintMode('report');
                let finished = false;
                const finishUp = () => {
                    if (finished) return;
                    finished = true;
                    window.removeEventListener('afterprint', finishUp);
                    resolve();
                };
                window.addEventListener('afterprint', finishUp);
                window.print();
                setTimeout(finishUp, 5000);
            });
        }

//@fn printRoutingDestinationLabel
function printRoutingDestinationLabel(dest) {
            if (typeof dest !== 'string') return '?';
            if (dest.startsWith('device:')) {
                const id = dest.slice('device:'.length);
                const d = lastKnownNetworkDevices.find(x => x.deviceId === id);
                return d ? `${d.name} (device)` : 'a removed device';
            }
            return `${dest} (station)`;
        }

//@fn printSystemDrawerKickTest
function printSystemDrawerKickTest() {
            return queuePrintJob(() => runQueuedSystemPrint(() => {
                const bodyEl = document.getElementById('receipt-body');
                const previousHtml = bodyEl.innerHTML;

                bodyEl.innerHTML = '';
                bodyEl.appendChild(document.createTextNode('Cash Drawer Test\n'));
                const kickSpan = document.createElement('span');
                kickSpan.className = 'drawer-kick-bytes';
                kickSpan.textContent = buildDrawerKickAsciiString();
                bodyEl.appendChild(kickSpan);

                document.getElementById('receipt-modal').style.display = 'flex';
                setPrintMode('receipt');
                window.print();

                const restore = () => {
                    bodyEl.innerHTML = previousHtml;
                    document.getElementById('receipt-modal').style.display = 'none';
                    window.removeEventListener('afterprint', restore);
                };
                window.addEventListener('afterprint', restore);
            }));
        }

//@fn printViaSystemDialog
async function printViaSystemDialog() {
            const relayAvailable = await checkPrintRelayAvailable();
            if (relayAvailable) {
                const sent = await submitPrintRelayJob('receipt', lastReceiptText);
                if (sent) {
                    showToast('🖨️ Sent to the printer at this shop.');
                    closeReceiptAfterPrint();
                    return;
                }
                // Submission failed — fall through to this device's own
                // print window below rather than leave the receipt unprinted.
            }
            return printReceiptInNewWindow();
        }

//@fn productType
function productType(p) {
            return (p && p.type) || 'item';
        }

//@fn profitPeriodLabel
function profitPeriodLabel(range) {
            const fmt = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            return range.from === range.to ? fmt(range.from) : `${fmt(range.from)} — ${fmt(range.to)}`;
        }

//@fn promptAppInstall
async function promptAppInstall() {
            if (!deferredInstallPrompt) {
                updateInstallUI();
                return;
            }
            deferredInstallPrompt.prompt();
            try {
                await deferredInstallPrompt.userChoice;
            } catch (e) { /* dismissed — nothing to do */ }
            deferredInstallPrompt = null;
            updateInstallUI();
        }

//@fn pruneOrphanedLocStates
function pruneOrphanedLocStates(kind, currentLabels) {
            const map = kind === 'table' ? tableStates : roomStates;
            const valid = new Set(currentLabels);
            Object.keys(map).forEach((label) => { if (!valid.has(label)) delete map[label]; });
            safeSetItem(kind === 'table' ? 'pos_table_states' : 'pos_room_states', JSON.stringify(map));
        }

//@fn perfInstall
function perfInstall() {
            // renderAllViews() redraws every table in the app; it is called after each sale and each sync, often several times within a moment (a sync
            // applying data, then the sale's own refresh...). Calls that come within 250 ms of the previous one are folded into ONE redraw a moment
            // later, so a burst costs a single redraw instead of a redraw each. The first call is immediate; the last one is never lost.
            if (window.__perfInstalled) return;
            window.__perfInstalled = true;
            const orig = window.renderAllViews;
            if (typeof orig !== 'function') return;
            let last = 0, timer = null;
            window.renderAllViews = function (...args) {
                const now = Date.now();
                if (now - last >= 250 && !timer) { last = now; return orig.apply(this, args); }
                if (timer) return undefined;
                timer = setTimeout(() => { timer = null; last = Date.now(); try { orig.apply(window, args); } catch (e) { /* the next redraw will try again */ } }, Math.max(20, 250 - (now - last)));
                return undefined;
            };
        }

//@fn markSync
function markSync(status) {
            // zip 129: connectivity is decided in ONE place (window.PosNet, the connectivity block). A sync that worked says so; a request
            // that got no answer is only a reason for it to CHECK — it never sets "offline" by itself.
            try {
                if (window.PosNet) {
                    if (status === 'synced') window.PosNet.report('ok');
                    else if (status === 'offline') window.PosNet.report('neterr', 'a sync request got no answer');
                }
            } catch (e) { /* the dot still updates below */ }
            // What the app KNOWS (window.__syncStatus) is updated at once; what is SHOWN (the dot) changes calmly: a poll that answers in a fraction of a
            // second never turns the dot orange, a blip never turns it black, and the dot does not go orange again every few seconds while offline.
            // A busy server for a few seconds is not an error: the change is on its way again (see trackPush). Only a failure that lasts a
            // minute turns the dot to "problem". (zip 123)
            if (status === 'error' && window.__pushFailKind === 'busy' && Date.now() - (window.__pushFailSince || Date.now()) < 60000) status = 'syncing';
            window.__syncStatus = status;
            window.__syncStatusAt = Date.now();
            const ui = window.__syncUi || (window.__syncUi = { shown: null, timer: null });
            clearTimeout(ui.timer);
            const show = (s) => { if (ui.shown !== s) { ui.shown = s; setSyncStatus(s); } };
            if (status === 'synced') { show('synced'); return; }
            if (status === 'syncing') {
                if (ui.shown === 'offline') return;                                   // stay black until the result is known
                if (ui.shown === null) { show('syncing'); return; }                   // first look at start-up
                ui.timer = setTimeout(() => show('syncing'), window.__syncDotDelayMs || 1500);
                return;
            }
            // offline / error: only if it lasts (a phone that just changed network, a slow answer)
            ui.timer = setTimeout(() => show(status), window.__syncDotOfflineMs || 3000);
        }

//@fn probeServer
async function probeServer(ms) {
            // "Can I reach the server right now?" — a tiny request (the server answers "unchanged" in a few bytes) with its own short timeout.
            // Returns the HTTP status, or 0 when there was no answer at all (no connection / timed out). navigator.onLine is only a hint and is
            // often wrong (captive Wi-Fi, a phone that just woke up), so the badge is decided by whether the server actually answers.
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), ms || 6000);
            try {
                // zip 129: the tiny health endpoint (no licence lookup, no shop data, never cached) — the old probe was the full sync
                // endpoint, and a slow answer from it was taken as "no internet".
                const res = await fetch('/api/health?t=' + Date.now(), { method: 'GET', signal: controller.signal, cache: 'no-store' });
                // Side effect only — never changes what this function returns.
                // Feeds the offline eTIMS clock-drift guard (water/AquaPOS
                // today; harmless no-op via the typeof guard anywhere else
                // EtimsOffline isn't loaded) a trustworthy server timestamp
                // every time we happen to reach our own backend, so the
                // drift check has something to compare against even on a
                // device that's never talked to a local VSCU.
                if (typeof EtimsOffline !== 'undefined') {
                    const dateHeader = res.headers && res.headers.get && res.headers.get('date');
                    if (dateHeader) EtimsOffline.recordServerTime(dateHeader);
                }
                return res.status || 0;
            } catch (e) {
                return 0;
            } finally {
                clearTimeout(timer);
            }
        }

//@fn pullState
async function pullState() {
            // One pull at a time: a slow one is not stacked with the next poll. The one pull that must not be dropped — "fetch the
            // result of the push I just made" (see pushNow) — sets __pullAgain instead, and runs once more right after this one.
            if (window.__pullInFlight && Date.now() - (window.__pullStartedAt || 0) < 120000) return;
            window.__pullInFlight = true;
            window.__pullStartedAt = Date.now();
            try { await pullStateOnce(); }
            finally { window.__pullInFlight = false; }
            if (window.__pullAgain) { window.__pullAgain = false; setTimeout(() => { try { pullState().catch(() => {}); } catch (e) { /* the poll will */ } }, 0); }
        }

//@fn pullStateOnce
async function pullStateOnce() {
            // navigator.onLine === false is only a hint; ask the server before believing it.
            if (navigator.onLine === false && (await probeServer(4000)) === 0) {
                markSync('offline');
                return;
            }
            // Changes made on this device but not yet acknowledged by the server (still in the 300 ms wait, on their way, or that failed)
            // must reach the server BEFORE its copy is applied here — otherwise the older server copy lands on top of them and the edit is
            // lost for good (\"I changed it, refreshed, and it was back\"). If they can't be sent, keep them and skip this pull.
            if (hasUnsyncedWork()) {
                const sent = await flushPendingPush();
                if (!sent) return;
            }
            markSync('syncing');
            const localUpdatedAt = parseInt(localStorage.getItem('pos_last_synced_at') || '0', 10);
            // A poll that finds nothing new is a few bytes, but the first pull (or one that finds changes) can be the whole shop, and a cold
            // server or a slow mobile connection needs more than a few seconds. Each time one runs out of patience while the server IS
            // reachable the next attempt is allowed twice as long, up to 90 s; a success resets it.
            const base = window.__pullTimeoutMs || (localUpdatedAt > 0 ? 12000 : 45000);
            const timeoutMs = Math.min(90000, Math.max(base, window.__pullPatienceMs || 0));
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                // ?since= lets the server answer \"unchanged\" (a few bytes) instead of
                // re-sending the whole shop every poll — see pos-sync.js onRequestGet.
                const res = await fetch(apiUrl(SYNC_URL + (localUpdatedAt > 0 ? '?since=' + localUpdatedAt : '')), { method: 'GET', signal: controller.signal });
                // The server ANSWERED, so none of these is "offline" (zip 129: 403 and 4xx used to show as Offline).
                if (!res.ok) {
                    let code = '';
                    try { code = ((await res.clone().json()) || {}).code || ''; } catch (e) { /* no body */ }
                    if (window.PosNet) window.PosNet.reportHttp(res.status, code);
                    if (res.status === 403) checkLicenseStatus();
                    markSync('error');
                    return;
                }
                const data = await res.json();
                window.__pullPatienceMs = 0;
                if (data && data.unchanged) { markSync('synced'); return; }
                if (data && data.updatedAt && data.updatedAt > localUpdatedAt) {
                    applyRemotePayload(preparePulledPayload(data));
                }
                markSync('synced');
            } catch (e) {
                // Timed out or failed. Reachable server = just slow: say "Syncing", try again at once with more patience. No answer = Offline.
                const answered = await probeServer(5000);
                if (answered > 0) {
                    window.__pullPatienceMs = Math.min(90000, timeoutMs * 2);
                    markSync('syncing');
                    setTimeout(() => { try { pullState(); } catch (e2) { /* the poll will */ } }, 300);
                } else {
                    markSync('offline');
                }
            } finally {
                clearTimeout(timer);
            }
        }

//@fn pushNewStockAlerts
function pushNewStockAlerts(lowStockItems, expiringItems) {
            if (!stockNotificationsEnabled || !notificationsSupported() || Notification.permission !== 'granted') return;

            const record = loadNotifiedToday();
            const seen = new Set(record.keys);
            const freshLow = lowStockItems.filter(p => !seen.has('low:' + p.code));
            const freshExpiry = expiringItems.filter(p => !seen.has('exp:' + p.code));
            if (freshLow.length === 0 && freshExpiry.length === 0) return;

            if (freshLow.length === 1) {
                const p = freshLow[0];
                showStockNotification(
                    '⚠️ Low stock',
                    `${p.name} is down to ${formatQtyDisplay(p.qty, p.unit)} ${unitLabel(p.unit)}.`,
                    'low-' + p.code
                );
            } else if (freshLow.length > 1) {
                showStockNotification(
                    `⚠️ ${freshLow.length} items low on stock`,
                    freshLow.slice(0, 4).map(p => p.name).join(', ') + (freshLow.length > 4 ? `, +${freshLow.length - 4} more` : ''),
                    'low-batch'
                );
            }

            if (freshExpiry.length === 1) {
                const p = freshExpiry[0];
                const days = daysUntilExpiry(p.expiryDate);
                showStockNotification(
                    '⏳ Expiring soon',
                    `${p.name} ${days < 0 ? 'expired' : days === 0 ? 'expires today' : `expires in ${days} day${days === 1 ? '' : 's'}`}.`,
                    'exp-' + p.code
                );
            } else if (freshExpiry.length > 1) {
                showStockNotification(
                    `⏳ ${freshExpiry.length} items nearing expiry`,
                    freshExpiry.slice(0, 4).map(p => p.name).join(', ') + (freshExpiry.length > 4 ? `, +${freshExpiry.length - 4} more` : ''),
                    'exp-batch'
                );
            }

            freshLow.forEach(p => seen.add('low:' + p.code));
            freshExpiry.forEach(p => seen.add('exp:' + p.code));
            saveNotifiedToday({ date: todayLocalDateStr(), keys: [...seen] });
        }

//@fn notifySyncTooLarge
async function notifySyncTooLarge(res) {
            // HTTP 413 = this shop's data outgrew what the server accepts. The server now archives old history by itself long
            // before that (at 80% of the limit), so this is a last-resort case - and the till is NOT told: nobody at the counter
            // can do anything about it, and it still works and keeps its data. The owner sees it in the Owner Console
            // (Storage tab). We only record it for diagnostics.
            try { window.__syncTooLargeAt = Date.now(); } catch (e) { /* nothing to do */ }
        }

//@fn preparePulledPayload
function preparePulledPayload(data) {
            // A database shop sends only a recent window of the big logs (older history stays on the server, reachable by date range
            // via /api/history). Applying that as-is would make this device forget the older history it already holds, so merge instead:
            // the server's copy of every record wins, and records only this device has are kept. Never removes anything.
            try {
                if (!data || typeof data !== 'object') return data;
                try { if (typeof window.salesJournalSeen === 'function') window.salesJournalSeen(data); } catch (e) { /* housekeeping */ }
                if (data._hotFrom) window.__lastHotFrom = data._hotFrom;
                // what the server just sent, it has: those records are not sent back (zip 129)
                ['salesLog', 'stockMovementLog', 'returns', 'expenses', 'tradeCredits', 'attendanceLog', 'adminActivityLog', 'dispatchLog'].forEach((f) => { if (Array.isArray(data[f]) && data[f].length) ackServerRecords(f, data[f]); });
                const local = {
                    salesLog: typeof salesLog === 'undefined' ? null : salesLog,
                    stockMovementLog: typeof stockMovementLog === 'undefined' ? null : stockMovementLog,
                    returns: typeof returns === 'undefined' ? null : returns,
                    expenses: typeof expenses === 'undefined' ? null : expenses,
                    tradeCredits: typeof tradeCredits === 'undefined' ? null : tradeCredits,
                    attendanceLog: typeof attendanceLog === 'undefined' ? null : attendanceLog,
                    adminActivityLog: typeof adminActivityLog === 'undefined' ? null : adminActivityLog,
                    dispatchLog: typeof dispatchLog === 'undefined' ? null : dispatchLog,
                };
                const keyOf = (r) => (r && typeof r === 'object') ? (r.id != null ? 'i:' + r.id : r.code != null ? 'c:' + r.code : r.token != null ? 't:' + r.token : null) : null;
                const timeOf = (r) => { for (const f of ['timestamp', 'date', 'createdAt', 'clockIn', 'at']) { if (r && r[f] != null) { const t = typeof r[f] === 'number' ? r[f] : Date.parse(r[f]); if (isFinite(t)) return t; } } return NaN; };
                let out = { ...data };
                syncJournalConflicts(data.stockMovementLog);
                try { if (data.tillNumbers && typeof data.tillNumbers === 'object') rememberTillNumber(data.tillNumbers[getOrCreateDeviceId()]); } catch (e) { /* next sync */ }
                if (data._ledger) {
                    stockLedgerMark(true);
                    out = stockApplyPulledLedger(out);
                    if (typeof aquaApplyPulledCells === 'function' && (Array.isArray(out.products) || Array.isArray(out.tanks) || Array.isArray(out.rawMaterials))) out = aquaApplyPulledCells(out);
                }
                setTimeout(ackLocalFields, 0);              // once the app has applied this payload, the settings are in agreement with the server
                if (data._hotFrom) setTimeout(() => { hydrateOlderHistory(data._hotFrom); }, 4000);     // fetch the older history in the background
                Object.keys(local).forEach((f) => {
                    const mine = local[f];
                    const theirs = data[f];
                    // A database shop's answer lists only the logs it holds rows for, so a shop whose first sales have not reached it yet
                    // sends no salesLog at all. "Not sent" is not "empty": keep this device's records (the apps would otherwise apply []).
                    if (Array.isArray(mine) && mine.length && theirs == null) { out[f] = mine; return; }
                    if (!Array.isArray(mine) || !Array.isArray(theirs) || mine.length === 0) return;
                    const have = new Set();
                    theirs.forEach((r) => { const k = keyOf(r); if (k != null) have.add(k); });
                    const extra = mine.filter((r) => { const k = keyOf(r); return k != null && !have.has(k); });
                    if (extra.length === 0) return;
                    const merged = theirs.concat(extra);
                    const dated = merged.filter((r) => isFinite(timeOf(r))).sort((a, b) => timeOf(a) - timeOf(b));
                    out[f] = dated.concat(merged.filter((r) => !isFinite(timeOf(r))));
                });
                return out;
            } catch (e) { return data; }       // never let this get in the way of applying what the server sent
        }

//@fn pushNow
async function pushNow() {
            return trackPush(async () => {
                markSync('syncing');
                // Snapshot BEFORE collecting the payload — see ackLocalDirty()'s
                // note on why this must be the count at push-start, not whatever
                // it is by the time the response comes back.
                let seqAtStart = '0';
                try { seqAtStart = localStorage.getItem('pos_dirty_seq') || '0'; } catch (e) { /* best effort */ }
                const payload = collectSyncPayload();
                try { await syncHaveCheck(payload); } catch (e) { /* batching covers it */ }
                const slim = slimPayloadForPush(payload);
                // A push that never gets an answer used to sit at "Syncing…" for as long as the browser cared to wait (minutes), blocking
                // every later push and pull behind it. It now gives up after 40 s (the poll retries).
                const pushAbortController = new AbortController();
                const pushAbortTimer = setTimeout(() => pushAbortController.abort(), window.__pushTimeoutMs || 40000);
                try {
                    const res = await fetch(apiUrl(SYNC_URL), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(slim.body),
                        signal: pushAbortController.signal
                    });
                    if (res.ok) {
                        slim.commit();
                        pushBacklogAfter(slim);
                        const data = await res.json();
                        if (data && data.till) rememberTillNumber(data.till);
                        const ledgerJustOn = !!(data && data.ledger) && stockLedgerMark(true);
                        // "Synced up to <the server's time>" is only true if the server had NOTHING newer than what this device already held when
                        // the push arrived. If another device changed something in between (data.prev is the server's time before our push), our
                        // push merged into that change, and this device has not SEEN it yet — so don't move the marker: the next pull fetches it.
                        // (Before, a device that pushed right after another one's change marked itself up to date and missed that change until the
                        // NEXT push from anyone.)
                        const heldUpTo = parseInt(localStorage.getItem('pos_last_synced_at') || '0', 10);
                        // With the stock ledger the server decides the quantities (it may not agree with this device's own arithmetic — a
                        // stale till, a count that was superseded), so a push that carried stock movements is followed by a pull of the result.
                        const movedStock = ledgerJustOn || !!(data && data.ledger && (
                            (Array.isArray(slim.body.stockMovementLog) && slim.body.stockMovementLog.length)
                            || (Array.isArray(slim.body.inventory) && slim.body.inventory.some((r) => r && r.code != null && typeof r.qty === 'number' && typeof r._sq !== 'number'))));
                        const missedSomething = movedStock || (typeof data.prev === 'number' && data.prev > heldUpTo && heldUpTo > 0);
                        if (!missedSomething) safeSetItem('pos_last_synced_at', String(data.updatedAt || payload.updatedAt));
                        else setTimeout(() => { try { if (window.__pullInFlight) window.__pullAgain = true; else pullState(); } catch (e) { /* the poll will */ } }, 50);
                        if (!slim.more) ackLocalDirty(seqAtStart);               // more batches to send: still "unsent work"
                        snapshotInventorySync();
                        snapshotExtraSyncedFields();
                        window.__pushFails = 0; window.__pushBackoffUntil = 0; window.__pushFailKind = '';
                        markSync('synced');
                        return true;
                    } else {
                        notePushHttp(res);                                  // the server ANSWERED: busy (sent again in seconds) or refused
                        const code = await pushErrorCode(res);
                        if (window.PosNet) window.PosNet.reportHttp(res.status, code);
                        if (res.status === 403) checkLicenseStatus();
                        if (res.status === 413) {
                            if (code === 'push_too_large') { pushShrinkBatches(); markSync('syncing'); return false; }   // smaller batches, sent again
                            notifySyncTooLarge(res); markSync('error'); return false;
                        }
                        markSync('error');
                        return false;
                    }
                } catch (e) {
                    // no answer / timed out. A push that timed out while the server IS reachable was too big for this line: smaller
                    // batches next time (zip 129). Whether the device is online at all is decided by the connectivity manager.
                    window.__pushFailKind = 'network';
                    if (e && e.name === 'AbortError') pushShrinkBatches();
                    markSync((await probeServer(5000)) > 0 ? 'error' : 'offline');
                    return false;
                } finally {
                    clearTimeout(pushAbortTimer);
                }
            });
        }

//@fn pushSharedReceiptSettingsIfNeeded
async function pushSharedReceiptSettingsIfNeeded() {
            if (!myBranchGroupId || !myIsMainBranch || !receiptSettingsUseShared) return;
            try {
                await fetch(apiUrl('/api/receipt-settings'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'save', settings: collectReceiptSettingsSnapshot() }),
                });
            } catch (e) {
                // A failed push here isn't the end of the world — the setting
                // is still saved locally and this branch still prints
                // correctly; it just hasn't propagated to the others yet.
            }
        }

//@fn qtyInputHint
function qtyInputHint(raw, unit) {
            const n = parseQtyInput(raw);
            if (isNaN(n)) return String(raw).trim() ? '?' : '';
            if (!isDecimalUnit(unit)) return formatQty(n, unit);
            return qtyDisplayFormat === 'fraction'
                ? decimalToFraction(n)
                : (Math.round(n * 1000) / 1000).toString();
        }

//@fn queuePrintJob
function queuePrintJob(jobFn) {
            printQueueTail = printQueueTail.then(jobFn, jobFn); // run next job even if the previous one rejected
            return printQueueTail;
        }

//@fn receiptImageWidthPx
function receiptImageWidthPx() {
            const widthMm = receiptPaperMm();
            return Math.max(360, Math.round(widthMm * 7.5));
        }

//@fn recipeIngredientMatchOptions
function recipeIngredientMatchOptions(selectedCode) {
            const pool = inventory.filter(isRecipeComponent).slice().sort((a, b) => a.name.localeCompare(b.name));
            let html = `<option value="">✨ New Ingredient</option>`;
            pool.forEach(p => {
                html += `<option value="${escapeHtml(p.code)}" ${p.code === selectedCode ? 'selected' : ''}>${escapeQuotes(p.name)}</option>`;
            });
            return html;
        }

//@fn refreshEtimsReceiptInfo
async function refreshEtimsReceiptInfo() {
            try {
                const res = await fetch(apiUrl('/api/etims-config'));
                const cfg = await res.json();
                etimsPin = cfg.hasEtimsConfig ? (cfg.etimsPin || '') : '';
            } catch (e) {
                // Leave whatever was already known — a failed refresh
                // shouldn't blank out the PIN on an otherwise-working receipt.
            }
        }

//@fn registerEtims
async function registerEtims() {
            const msgEl = document.getElementById('etims-register-msg');
            const pin = document.getElementById('etims-pin-input').value.trim().toUpperCase();
            const branchId = document.getElementById('etims-branch-id-input').value.trim();
            const env = document.getElementById('etims-env-input').value;

            if (!pin) { msgEl.className = 'settings-msg error'; msgEl.textContent = 'Enter your KRA PIN first.'; return; }

            msgEl.className = 'settings-msg';
            msgEl.textContent = 'Registering with KRA… this can take a few seconds.';

            try {
                const res = await fetch(apiUrl('/api/etims-config'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'register', pin, branchId, env }),
                });
                const data = await res.json();
                if (!res.ok || data.error) {
                    msgEl.className = 'settings-msg error';
                    msgEl.textContent = data.error || 'Could not register — try again.';
                    return;
                }
                msgEl.className = 'settings-msg success';
                msgEl.textContent = 'Registered successfully.';
                checkEtimsStatus();
                refreshEtimsReceiptInfo();
            } catch (e) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = netErrText('Could not reach the server');
            }
        }

//@fn registerSyncedField
function registerSyncedField(name, getter, keyField) {
            try {
                if (Array.isArray(getter())) extraSyncedFields.push({ name, getter, keyField });
            } catch (e) { /* this app doesn't have this field — skip */ }
        }

//@fn registerTillUrls
async function registerTillUrls() {
            const msgEl = document.getElementById('gateway-c2b-register-msg');
            msgEl.className = 'settings-msg';
            msgEl.textContent = 'Registering with Safaricom…';
            try {
                const res = await fetch(apiUrl('/api/mpesa-c2b-register'), { method: 'POST' });
                const data = await res.json();
                if (!res.ok || data.error) {
                    msgEl.className = 'settings-msg error';
                    msgEl.textContent = data.error || 'Could not register — try again.';
                    return;
                }
                msgEl.className = 'settings-msg success';
                msgEl.textContent = '✅ Registered — payments made straight to your till will now show up below.';
            } catch (e) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = netErrText('Could not reach the server');
            }
        }

//@fn removeAiCaptureOwnKey
async function removeAiCaptureOwnKey(id) {
            if (!confirm("Remove this Gemini API key? AI Capture List will fall back to any other saved key, or the platform's shared pool if none remain.")) return;
            const msgEl = document.getElementById('ai-capture-own-key-msg');
            try {
                await fetch(apiUrl('/api/ai-capture-list'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'remove', id }),
                });
            } catch (e) { /* fall through — status check below reflects reality either way */ }
            if (msgEl) { msgEl.className = 'settings-msg'; msgEl.textContent = 'Removed.'; }
            checkAiCaptureStatus();
        }

//@fn removeBiometric
async function removeBiometric(credentialId) {
            await deleteWebAuthnCredential(credentialId);
            renderBiometricList();
        }

//@fn removeBulkRow
function removeBulkRow(id) {
            if (bulkAddRows.length <= 1) { bulkAddRows = [makeBulkRow()]; }
            else { bulkAddRows = bulkAddRows.filter(r => r.id !== id); }
            renderBulkAddTable();
        }

//@fn removeComboRow
function removeComboRow(idx) {
            comboDraft.splice(idx, 1);
            renderComboRows();
        }

//@fn removeContractRow
function removeContractRow(rowId) {
            contractDraft = contractDraft.filter(r => r.rowId !== rowId);
            if (contractDraft.length === 0) contractDraft.push({ rowId: contractRowSeq++, name: '', qty: '', price: '' });
            renderContractRows();
        }

//@fn removeDeliveryAgent
function removeDeliveryAgent(id) {
            const agent = deliveryAgents.find(a => a.id === id);
            if (!agent) return;
            if (!confirm(`Remove "${agent.name}" from the delivery agent list?`)) return;
            deliveryAgents = deliveryAgents.filter(a => a.id !== id);
            queuePush();
            renderDeliveryAgentsSettingsList();
            showToast(`Removed "${agent.name}".`);
        }

//@fn removeDeliveryZone
function removeDeliveryZone(id) {
            const zone = deliveryZones.find(z => z.id === id);
            if (!zone) return;
            if (!confirm(`Remove the "${zone.name}" delivery zone?`)) return;
            deliveryZones = deliveryZones.filter(z => z.id !== id);
            queuePush();
            renderDeliveryZonesList();
            showToast(`Removed "${zone.name}".`);
        }

//@fn removeExchangeReplacementItem
function removeExchangeReplacementItem(code) {
            exchangeReplacementItems = exchangeReplacementItems.filter(l => l.code !== code);
            renderExchangeItemsTable();
            renderExchangeBalance();
        }

//@fn removeLoyaltyTier
function removeLoyaltyTier(id) {
            loyaltyTiers = loyaltyTiers.filter(t => t.id !== id);
            renderLoyaltyTiersList();
        }

//@fn removeOffer
function removeOffer() {
            const product = inventory.find(p => p.code === pendingOfferCode);
            if (!product) return;
            delete product.offer;
            safeSetItem('pos_inventory', JSON.stringify(inventory));
            queuePush();
            closeOfferModal();
            renderInventoryTable();
            renderNotifications();
            showToast(`Offer removed for "${product.name}".`);
        }

//@fn removeRecipeCaptureDish
function removeRecipeCaptureDish(dishId) {
            recipeCaptureState.dishes = recipeCaptureState.dishes.filter(d => d.id !== dishId);
            renderRecipeCaptureReview();
        }

//@fn removeRecipeCaptureIngredient
function removeRecipeCaptureIngredient(dishId, ingId) {
            const dish = recipeCaptureState.dishes.find(d => d.id === dishId);
            if (!dish) return;
            dish.ingredients = dish.ingredients.filter(i => i.id !== ingId);
            flagWithinImportIngredientDuplicates();
            renderRecipeCaptureReview();
        }

//@fn removeRecipeRow
function removeRecipeRow(idx) {
            recipeDraft.splice(idx, 1);
            renderRecipeRows();
        }

//@fn removeRoom
function removeRoom(label) {
            rooms = rooms.filter(r => r !== label);
            safeSetItem('pos_rooms', JSON.stringify(rooms));
            delete roomStates[label];
            safeSetItem('pos_room_states', JSON.stringify(roomStates));
            queuePush();
            renderTablesRoomsLists();
            renderSalesLocationSelect();
        }

//@fn removeSavedVariant
function removeSavedVariant(parentCode, variantId) {
            const product = inventory.find(p => p.code === parentCode);
            if (!product || !Array.isArray(product.variants)) return;
            const variant = product.variants.find(v => v.id === variantId);
            if (!variant) return;

            if (!confirm(`Remove the "${variant.name}" variant of "${product.name}"?`)) return;

            product.variants = product.variants.filter(v => v.id !== variantId);

            if (product.variants.length === 0) {
                product.hasVariants = false;
                product.qty = 0;
                product.price = 0;
                showToast(`Removed the last variant — "${product.name}" is now a plain item with no stock. Set it up again, or add new variants, from Add New Items.`);
            } else {
                product.qty = product.variants.reduce((sum, v) => sum + v.qty, 0);
                product.price = Math.min(...product.variants.map(v => v.price));
                showToast(`Removed "${variant.name}".`);
            }

            safeSetItem('pos_inventory', JSON.stringify(inventory));
            queuePush();
            renderInventoryTable();
        }

//@fn removeTable
function removeTable(label) {
            tables = tables.filter(t => t !== label);
            safeSetItem('pos_tables', JSON.stringify(tables));
            delete tableStates[label];
            safeSetItem('pos_table_states', JSON.stringify(tableStates));
            queuePush();
            renderTablesRoomsLists();
            renderSalesLocationSelect();
        }

//@fn removeVariantsModalRow
function removeVariantsModalRow(id) {
            if (variantsModalDraft.length <= 1) {
                showToast('An item with variants needs at least one — remove the whole item from Inventory instead if you no longer need any of them.', true);
                return;
            }
            if (!confirm('Remove this variant? Its stock count is removed with it.')) return;
            variantsModalDraft = variantsModalDraft.filter(v => v.id !== id);
            renderVariantsModalList();
        }

//@fn renderAdminActivityLog
function renderAdminActivityLog() {
            const tbody = document.querySelector('#admin-activity-log-table tbody');
            if (!tbody) return;
            const list = adminActivityLog.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            tbody.innerHTML = list.length === 0
                ? `<tr><td colspan="3" class="empty-state">No Secondary Admin activity recorded yet.</td></tr>`
                : list.map(e => `<tr><td>${new Date(e.timestamp).toLocaleString('en-GB')}</td><td>${escapeHtml(e.userName)}</td><td>${escapeHtml(e.sectionLabel)}</td></tr>`).join('');
        }

//@fn renderAndPrintBarcodes
function renderAndPrintBarcodes(list) {
            if (!list || list.length === 0) {
                showToast('No saved barcodes to print yet.', true);
                return;
            }
            let tiles = '';
            list.forEach(b => {
                const svg = renderCode39SVG(b.value, { height: 60 });
                for (let i = 0; i < (b.copies || 1); i++) {
                    tiles += `
                        <div class="barcode-tile">
                            <div class="barcode-tile-label">${escapeHtml(b.label)}</div>
                            ${svg}
                            <div class="barcode-tile-value">${escapeHtml(b.value)}</div>
                        </div>`;
                }
            });
            document.getElementById('barcode-print-sheet').innerHTML = `<div class="barcode-print-grid">${tiles}</div>`;
            setPrintMode('barcodes');
            window.print();
        }

//@fn renderAttendanceHistory
function renderAttendanceHistory() {
            const tbody = document.querySelector('#attendance-history-table tbody');
            if (!tbody) return;
            const fromEl = document.getElementById('attendance-history-from');
            const toEl = document.getElementById('attendance-history-to');
            const from = fromEl && fromEl.value ? fromEl.value : todayDateString();
            const to = toEl && toEl.value ? toEl.value : from;
            const list = attendanceLog
                .filter(e => { const k = dateKey(new Date(e.clockIn)); return k >= from && k <= to; })
                .sort((a, b) => new Date(b.clockIn) - new Date(a.clockIn));
            if (list.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No attendance records in this range.</td></tr>`;
                return;
            }
            tbody.innerHTML = list.map(e => {
                const hours = e.clockOut ? ((new Date(e.clockOut) - new Date(e.clockIn)) / 3600000) : ((Date.now() - new Date(e.clockIn)) / 3600000);
                const expected = expectedTimesForPersonKey(e.personKey);
                const inDeviation = attendanceDeviationLabel(e.clockIn, expected.clockIn);
                const outDeviation = e.clockOut ? attendanceDeviationLabel(e.clockOut, expected.clockOut) : '';
                const deviationSpan = (label) => label ? ` <span style="font-size:11px; color:${label.startsWith('Late') ? 'var(--danger)' : '#e67e22'};">(${label})</span>` : '';
                return `<tr>
                    <td>${escapeHtml(e.personName)}</td>
                    <td>${new Date(e.clockIn).toLocaleString('en-GB')}${deviationSpan(inDeviation)}</td>
                    <td>${e.clockOut ? new Date(e.clockOut).toLocaleString('en-GB') + deviationSpan(outDeviation) : '<em>Still clocked in</em>'}</td>
                    <td>${formatHours(hours)}</td>
                </tr>`;
            }).join('');
        }

//@fn renderAttendanceRosterTable
function renderAttendanceRosterTable() {
            const tbody = document.querySelector('#attendance-roster-table tbody');
            if (!tbody) return;
            tbody.innerHTML = attendanceRoster.length === 0
                ? `<tr><td colspan="5" class="empty-state">No non-POS people added yet.</td></tr>`
                : attendanceRoster.map(r => `
                    <tr>
                        <td>${escapeHtml(r.name)}</td>
                        <td>${r.pin ? '✅' : '—'}</td>
                        <td><input class="inv-edit-input" type="time" value="${escapeHtml(r.expectedClockIn || '')}" onchange="updateAttendanceRosterExpectedTime('${escapeJsAttr(r.id)}', 'expectedClockIn', this.value)"></td>
                        <td><input class="inv-edit-input" type="time" value="${escapeHtml(r.expectedClockOut || '')}" onchange="updateAttendanceRosterExpectedTime('${escapeJsAttr(r.id)}', 'expectedClockOut', this.value)"></td>
                        <td><button class="remove-btn" onclick="removeAttendanceRosterPerson('${escapeJsAttr(r.id)}')">Remove</button></td>
                    </tr>`).join('');
        }

//@fn renderBarcodeLinkOptions
function renderBarcodeLinkOptions() {
            const select = document.getElementById('barcode-link-select');
            if (!select) return;
            const current = select.value;
            const items = inventory.filter(p => (p.type || 'item') !== 'service');
            select.innerHTML = `<option value="">— Not linked, label only —</option>` +
                items.map(p => `<option value="${escapeHtml(p.code)}">${escapeHtml(p.name)} (#${escapeHtml(p.code)})</option>`).join('');
            if (items.some(p => p.code === current)) select.value = current;
        }

//@fn renderBarcodesTab
function renderBarcodesTab() {
            renderSavedBarcodesTable();
            previewBarcode();
        }

//@fn renderBillNotifyStaffList
function renderBillNotifyStaffList() {
            const wrap = document.getElementById('bill-notify-staff-list');
            if (!wrap) return;
            const daysInput = document.getElementById('bill-reminder-days-input');
            if (daysInput) daysInput.value = billReminderDaysBefore;
            if (staff.length === 0) {
                wrap.innerHTML = `<p class="settings-hint" style="margin:0;">No staff accounts yet — add some under 👥 Staff Accounts first.</p>`;
                return;
            }
            wrap.innerHTML = staff.map(s => `
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:normal;">
                    <input type="checkbox" style="width:auto;" ${billNotifyStaffIds.includes(s.id) ? 'checked' : ''} onchange="toggleBillNotifyStaff('${escapeJsAttr(s.id)}', this.checked)">
                    ${escapeHtml(s.name)}
                </label>
            `).join('');
        }

//@fn renderBillsTabScoped
function renderBillsTabScoped() {
            if (viewedBranchId === 'self') { renderBillsTab(); setTabReadOnly('bills-tab', false); return; }
            const backupBills = bills;
            bills = scopedField('bills', bills);
            try { renderBillsTab(); } finally { bills = backupBills; }
            setTabReadOnly('bills-tab', true);
        }

//@fn renderBizImportReviewTables
function renderBizImportReviewTables() {
            const s = bizImportReviewState;
            if (!s) return;
            document.getElementById('biz-import-stock-count').textContent = s.stockItems.length;
            document.getElementById('biz-import-debts-count').textContent = s.debtRows.length;
            document.querySelector('#biz-import-stock-table tbody').innerHTML = s.stockItems.length === 0
                ? `<tr><td colspan="10" class="empty-state">No stock rows detected.</td></tr>`
                : s.stockItems.map(it => `
                <tr>
                    <td><input type="checkbox" ${it.checked ? 'checked' : ''} onchange="updateBizImportStockField('${it.id}','checked',this.checked)"></td>
                    <td><input type="text" style="width:110px;" value="${escapeHtml(it.name)}" oninput="updateBizImportStockField('${it.id}','name',this.value)"></td>
                    <td><input type="text" style="width:70px;" value="${escapeHtml(it.sku)}" oninput="updateBizImportStockField('${it.id}','sku',this.value)"></td>
                    <td><input type="number" style="width:70px;" min="0" step="0.01" value="${it.retail}" oninput="updateBizImportStockField('${it.id}','retail',this.value)"></td>
                    <td><input type="number" style="width:70px;" min="0" step="0.01" value="${it.buying}" oninput="updateBizImportStockField('${it.id}','buying',this.value)"></td>
                    <td><input type="number" style="width:60px;" min="0" step="0.01" value="${it.openingQty}" oninput="updateBizImportStockField('${it.id}','openingQty',this.value)"></td>
                    <td><input type="number" style="width:60px;" min="0" step="0.01" value="${it.addedQty}" oninput="updateBizImportStockField('${it.id}','addedQty',this.value)"></td>
                    <td><input type="number" style="width:60px;" min="0" step="0.01" value="${it.soldQty}" oninput="updateBizImportStockField('${it.id}','soldQty',this.value)"></td>
                    <td><input type="number" style="width:60px;" min="0" step="0.01" value="${it.closingQty}" oninput="updateBizImportStockField('${it.id}','closingQty',this.value)"></td>
                    <td>${it.matchedCode ? '🔄 Restock existing' : '✨ New item'}</td>
                </tr>`).join('');
            document.querySelector('#biz-import-debts-table tbody').innerHTML = s.debtRows.length === 0
                ? `<tr><td colspan="3" class="empty-state">No debts detected.</td></tr>`
                : s.debtRows.map(d => `
                <tr>
                    <td><input type="checkbox" ${d.checked ? 'checked' : ''} onchange="updateBizImportDebtField('${d.id}','checked',this.checked)"></td>
                    <td><input type="text" value="${escapeHtml(d.name)}" oninput="updateBizImportDebtField('${d.id}','name',this.value)"></td>
                    <td><input type="number" min="0" step="0.01" value="${d.amount}" oninput="updateBizImportDebtField('${d.id}','amount',this.value)"></td>
                </tr>`).join('');
        }

//@fn renderCameraScanTorchButton
function renderCameraScanTorchButton() {
            const el = document.getElementById('camera-scan-torch-row');
            if (!el) return;
            el.style.display = (cameraScanStream && cameraScanTorchSupported) ? 'flex' : 'none';
            const btn = document.getElementById('camera-scan-torch-btn');
            if (btn) btn.textContent = cameraScanTorchOn ? '🔦 Turn Flash Off' : '🔦 Turn Flash On';
        }

//@fn renderComboRows
function renderComboRows() {
            const wrap = document.getElementById('combo-rows');
            if (!wrap) return;

            if (comboDraft.length === 0) {
                wrap.innerHTML = `<p style="color:#7f8c8d; font-size:13px;">No combo items added yet.</p>`;
                return;
            }

            wrap.innerHTML = comboDraft.map((row, idx) => `
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap; padding:8px; background:white; border-radius:6px;">
                    <div class="type-toggle" style="flex-shrink:0;">
                        <button type="button" class="type-toggle-btn ${row.mode === 'existing' ? 'active' : ''}" style="padding:6px 10px; font-size:12px;" onclick="setComboRowMode(${idx}, 'existing')">From Stock</button>
                        <button type="button" class="type-toggle-btn ${row.mode === 'custom' ? 'active' : ''}" style="padding:6px 10px; font-size:12px;" onclick="setComboRowMode(${idx}, 'custom')">Type a Name</button>
                    </div>
                    ${row.mode === 'existing'
                        ? `<select style="flex:2; min-width:150px;" onchange="updateComboRowCode(${idx}, this.value)">${comboItemOptionsHtml(row.code)}</select>`
                        : `<input type="text" style="flex:2; min-width:150px;" placeholder="e.g. Free soda refill" value="${escapeHtml(row.customName)}" oninput="updateComboRowCustomName(${idx}, this.value)">`
                    }
                    <input type="number" min="1" step="1" style="width:70px;" placeholder="Qty" value="${row.qty}" oninput="updateComboRowQty(${idx}, this.value)">
                    <button type="button" class="remove-btn" onclick="removeComboRow(${idx})">✕</button>
                </div>`
            ).join('');
        }

//@fn renderContractTotals
function renderContractTotals() {
            const total = contractDraft.reduce((sum, r) => sum + contractRowLineTotal(r), 0);
            const totalEl = document.getElementById('contract-grand-total');
            if (totalEl) totalEl.textContent = `KES ${total.toFixed(2)}`;
            document.querySelectorAll('.contract-line-total').forEach(el => {
                const rowId = parseInt(el.dataset.rowId, 10);
                const row = contractDraft.find(r => r.rowId === rowId);
                if (row) el.textContent = `KES ${contractRowLineTotal(row).toFixed(2)}`;
            });
        }

//@fn renderDailySalesScoped
function renderDailySalesScoped() {
            if (viewedBranchId === 'self') { renderDailySales(); setTabReadOnly('daily-sales-tab', false); return; }
            const backup = salesLog;
            salesLog = scopedField('salesLog', salesLog);
            try { renderDailySales(); } finally { salesLog = backup; }
            setTabReadOnly('daily-sales-tab', true);
        }

//@fn renderDeliveriesNotifList
function renderDeliveriesNotifList() {
            const wrap = document.getElementById('deliveries-notif-list');
            if (!wrap) return;
            const relevant = currentServer
                ? deliveryNotifications.filter(n => !n.read && n.agentKey === currentServer.id)
                : deliveryNotifications.filter(n => !n.read);
            if (relevant.length === 0) { wrap.innerHTML = ''; return; }
            wrap.innerHTML = `
                <div style="background:#FDEBD0; border:1px solid #f0b27a; border-radius:8px; padding:10px; margin-bottom:12px;">
                    <b>🔔 New Assignments</b>
                    ${relevant.map(n => `<div style="margin-top:6px; font-size:13px;">${escapeHtml(n.message)}</div>`).join('')}
                    <button class="settings-small-btn" style="margin-top:8px;" onclick="markDeliveryNotificationsRead()">Mark all as read</button>
                </div>`;
        }

//@fn renderDeliveryAgentSelect
function renderDeliveryAgentSelect() {
            const select = document.getElementById('delivery-agent-select');
            if (!select) return;
            const agents = getAllDeliveryAgents();
            select.innerHTML = `<option value="">— Unassigned —</option>` +
                agents.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}${a.type === 'external' ? ' (external)' : ''}</option>`).join('');
        }

//@fn renderDeliveryZoneSelect
function renderDeliveryZoneSelect() {
            const select = document.getElementById('delivery-zone-select');
            if (!select) return;
            select.innerHTML = `<option value="">Choose a zone, or set the fee manually below</option>` +
                deliveryZones.map(z => `<option value="${escapeHtml(z.id)}">${escapeHtml(z.name)} — ${money(z.fee)}</option>`).join('');
        }

//@fn renderDeliveryZonesList
function renderDeliveryZonesList() {
            const wrap = document.getElementById('delivery-zones-list');
            if (!wrap) return;
            wrap.innerHTML = deliveryZones.length === 0
                ? `<p style="color:#7f8c8d; font-size:13px;">No delivery zones set up yet.</p>`
                : deliveryZones.map(z => `
                    <div style="display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid var(--light); flex-wrap:wrap;">
                        <input class="inv-edit-input" type="text" style="flex:1; min-width:120px;" value="${escapeHtml(z.name)}" onchange="updateDeliveryZone('${escapeJsAttr(z.id)}', 'name', this.value)">
                        <label style="font-size:11px; color:#7f8c8d; display:flex; flex-direction:column; gap:2px;">Customer Fee
                            <input class="inv-edit-input" type="number" min="0" step="1" style="width:100px;" value="${z.fee}" onchange="updateDeliveryZone('${escapeJsAttr(z.id)}', 'fee', this.value)">
                        </label>
                        <label style="font-size:11px; color:#7f8c8d; display:flex; flex-direction:column; gap:2px;">Standard Cost
                            <input class="inv-edit-input" type="number" min="0" step="1" style="width:100px;" value="${z.opCost || 0}" onchange="updateDeliveryZone('${escapeJsAttr(z.id)}', 'opCost', this.value)">
                        </label>
                        <button class="remove-btn" onclick="removeDeliveryZone('${escapeJsAttr(z.id)}')">Remove</button>
                    </div>`).join('');
        }

//@fn renderFaultyItemsRegister
function renderFaultyItemsRegister() {
            const tbody = document.querySelector('#faulty-items-table tbody');
            if (!tbody) return;
            const faulty = getFaultyReturns().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            if (faulty.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No faulty items logged yet.</td></tr>`;
                return;
            }
            tbody.innerHTML = faulty.map(r => `
                <tr>
                    <td><input type="checkbox" class="faulty-item-checkbox" data-return-id="${escapeHtml(r.id)}" ${r.sentToSupplierAt ? 'disabled' : ''}></td>
                    <td>${new Date(r.timestamp).toLocaleDateString('en-GB')}</td>
                    <td>${escapeHtml(r.itemName)}</td>
                    <td>${r.qty}</td>
                    <td>${escapeHtml(r.reason)}</td>
                    <td>${r.sentToSupplierAt ? `✅ ${new Date(r.sentToSupplierAt).toLocaleDateString('en-GB')}` : '—'}</td>
                </tr>`).join('');
        }

//@fn renderGasSupplierHistory
function renderGasSupplierHistory() {
            const el = document.getElementById('gas-supplier-history');
            if (!el) return;
            if (gasSupplierHistory.length === 0) { el.innerHTML = ''; return; }
            const words = { send: 'Sent empty', receive: 'Received refilled', return: 'Swapped at the depot' };
            el.innerHTML = '<strong>Recent:</strong><br>' + gasSupplierHistory.slice(0, 8).map(h => {
                const date = new Date(h.timestamp).toLocaleString('en-GB');
                return `${date} — ${words[h.direction] || h.direction} ${h.qty} × ${escapeHtml(h.label)}`;
            }).join('<br>');
        }

//@fn renderGasTab
function renderGasTab() {
            const fulls = getGasFullVariants().slice().sort((a, b) => gasLabelOf(a).localeCompare(gasLabelOf(b), undefined, { numeric: true }));
            if (!fulls.some(f => f.code === window.__gasSel)) window.__gasSel = fulls.length ? fulls[0].code : '';
            const n = (x) => (Math.round((Number(x) || 0) * 100) / 100).toString();

            // 1. how many cylinders, in what state
            const t = gasTotals();
            const totalsEl = document.getElementById('gas-totals');
            if (totalsEl) totalsEl.innerHTML = `<span class="gas-chip gas-full">🟢 Full <b>${t.full}</b></span><span class="gas-chip gas-empty">⚪ Empty <b>${t.empty}</b></span>${t.away ? `<span class="gas-chip gas-away">🚚 With supplier <b>${t.away}</b></span>` : ''}<span class="gas-chip">🛢️ All cylinders <b>${t.total}</b></span>`;

            // 2. the board: one row per size, counts and prices editable in place
            const tbody = document.getElementById('gas-board-body');
            if (tbody) {
                tbody.innerHTML = fulls.length === 0
                    ? '<tr><td colspan="8" class="empty-state">No sizes yet — add your first size below (for example 13kg, with how many full and empty you have).</td></tr>'
                    : fulls.map(f => {
                        const e = inventory.find(p => p.code === f.gasPairCode) || {};
                        const c = escapeJsAttr(f.code);
                        const num = (v, cb) => `<input type="number" min="0" step="1" value="${Math.round(v || 0)}" onchange="${cb}(this.value)">`;
                        const price = (v, field) => `<input type="number" min="0" step="0.01" value="${v ? n(v) : ''}" placeholder="—" onchange="gasBoardPrice('${c}', '${field}', this.value)">`;
                        return `<tr class="${f.code === window.__gasSel ? 'gas-row-selected' : ''}">
                            <td><strong>${escapeHtml(gasLabelOf(f))}</strong></td>
                            <td>${num(f.qty, `gasBoardSet.bind(null, '${c}', 'full')`)}</td>
                            <td>${num(e.qty, `gasBoardSet.bind(null, '${c}', 'empty')`)}</td>
                            <td>${f.gasAtSupplier || 0}</td>
                            <td><strong>${(f.qty || 0) + (e.qty || 0) + (f.gasAtSupplier || 0)}</strong></td>
                            <td>${price(f.price, 'outright')}</td><td>${price(f.gasRefillPrice, 'refill')}</td><td>${price(e.price, 'empty')}</td>
                        </tr>`;
                    }).join('');
            }

            // 3. pick a size to sell
            const chips = document.getElementById('gas-size-chips');
            if (chips) chips.innerHTML = fulls.map(f => {
                const e = inventory.find(p => p.code === f.gasPairCode) || {};
                return `<button type="button" class="gas-size-chip ${f.code === window.__gasSel ? 'active' : ''}" onclick="selectGasSize('${escapeJsAttr(f.code)}')">${escapeHtml(gasLabelOf(f))}<small>${f.qty || 0} full · ${e.qty || 0} empty</small></button>`;
            }).join('') || '<span class="settings-hint">Add a size first.</span>';

            // 4. supplier form
            const supplierSelect = document.getElementById('gas-supplier-variant-select');
            if (supplierSelect) { const cur = supplierSelect.value; supplierSelect.innerHTML = fulls.map(f => `<option value="${escapeHtml(f.code)}">${escapeHtml(gasLabelOf(f))}</option>`).join('') || '<option value="">— No sizes yet —</option>'; if (fulls.some(f => f.code === cur)) supplierSelect.value = cur; }

            // 5. accessories: ordinary inventory items that are marked as accessories
            const accs = getGasAccessories();
            const checklist = document.getElementById('gas-set-accessories-list');
            if (checklist) {
                const ticked = new Set(Array.from(checklist.querySelectorAll('.gas-acc-check:checked')).map(x => x.closest('.gas-acc-row').dataset.code));
                checklist.innerHTML = accs.length === 0 ? '<p class="settings-hint" style="margin:0;">No accessories marked yet — mark some in the Accessories box below.</p>'
                    : accs.map(a => `<div class="gas-acc-row" data-code="${escapeHtml(a.code)}"><label><input type="checkbox" class="gas-acc-check" ${ticked.has(a.code) ? 'checked' : ''}> ${escapeHtml(a.name)} <span class="kitchen-sub">KES ${n(a.price)} · ${n(a.qty)} in stock</span></label><input type="number" class="gas-acc-qty" min="1" step="1" value="1" title="How many per set"></div>`).join('');
            }
            const list = document.getElementById('gas-accessory-list');
            if (list) list.innerHTML = accs.map(a => `<span class="gas-chip">${escapeHtml(a.name)} <button type="button" title="Unmark" onclick="unmarkGasAccessory('${escapeJsAttr(a.code)}')">✕</button></span>`).join('') || '<span class="settings-hint">None yet.</span>';
            const pick = document.getElementById('gas-accessory-pick');
            if (pick) pick.innerHTML = '<option value="">— pick an inventory item —</option>' + inventory.filter(p => (p.type || 'item') === 'item' && !p.isGasCylinder && !p.isGasAccessory).sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(p => `<option value="${escapeHtml(p.code)}">${escapeHtml(p.name)}</option>`).join('');

            setGasTxType(gasTxType || 'exchange');
            renderGasSupplierHistory();
        }

//@fn renderGasVariantStock
function renderGasVariantStock() {
            const info = document.getElementById('gas-variant-stock-info');
            if (!info) return;
            const full = inventory.find(p => p.code === window.__gasSel);
            if (!full) { info.textContent = getGasFullVariants().length ? 'Pick a size.' : 'Add a cylinder size above to start.'; return; }
            const empty = inventory.find(p => p.code === full.gasPairCode);
            const kes = (n) => 'KES ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const line = {
                exchange: `Refill / exchange: ${kes(full.gasRefillPrice)} — the customer hands in an empty, so Full goes down by 1 and Empty goes up by 1.`,
                outright: `Full cylinder with gas: ${kes(full.price)} — Full goes down by 1 (the customer keeps the cylinder).`,
                set: `Full cylinder ${kes(full.price)} plus the accessories you tick below. Full goes down by 1.`,
                empty: `Empty cylinder on its own: ${kes(empty && empty.price)} — Empty goes down by 1.`,
            }[gasTxType] || '';
            info.innerHTML = `<strong>${escapeHtml(gasLabelOf(full))}</strong> — Full ${full.qty || 0} · Empty ${(empty && empty.qty) || 0}<br>${escapeHtml(line)}`;
        }

//@fn renderInvEditableCell
function renderInvEditableCell(id, field, value, commitCall, showScanBtn) {
            const key = invCellKey(id, field);
            if (inventoryEditingCells.has(key)) {
                const input = `<input class="inv-edit-input inv-cell-input" type="text" data-inv-cell="${escapeHtml(key)}"
                    value="${escapeHtml(value)}"
                    onblur="stopInvCellEdit('${escapeJsAttr(id)}', '${field}'); ${commitCall}"
                    onkeydown="if(event.key==='Enter'){ this.blur(); } else if(event.key==='Escape'){ stopInvCellEdit('${escapeJsAttr(id)}','${field}'); renderInventoryTable(); }">`;
                if (!showScanBtn) return input;
                return `<div style="display:flex; gap:4px; align-items:center;">${input}<button type="button" class="settings-small-btn" style="padding:0 6px;" onmousedown="event.preventDefault()" onclick="openBarcodeScanModal(code => updateInventoryField('${escapeJsAttr(id)}', '${field}', code))" title="Scan barcode">📷</button></div>`;
            }
            const displayVal = (value || '').trim() ? escapeHtml(value) : '<span style="color:#bbb;">(click to set)</span>';
            return `<div class="inv-cell-display" title="Click to edit" onclick="startInvCellEdit('${escapeJsAttr(id)}', '${field}')">${displayVal}</div>`;
        }

//@fn renderInventoryPager
function renderInventoryPager(current, total) {
            let pager = document.getElementById('inventory-pagination');
            if (!pager) {
                const table = document.getElementById('inventory-table');
                if (!table) return;
                // Insert after the .table-scroll wrapper, not the bare table --
                // that wrapper is overflow-x:auto (and, per this codebase's own
                // notes elsewhere, clips vertical overflow too), so a pager
                // placed inside it could be clipped or need a sideways scroll
                // to reach on mobile.
                const scrollWrap = table.closest('.table-scroll') || table;
                if (!scrollWrap.parentNode) return;
                pager = document.createElement('div');
                pager.id = 'inventory-pagination';
                pager.style.cssText = 'display:flex; gap:6px; align-items:center; justify-content:center; flex-wrap:wrap; margin-top:10px;';
                scrollWrap.parentNode.insertBefore(pager, scrollWrap.nextSibling);
            }
            if (total <= 1) { pager.innerHTML = ''; return; }
            const windowSize = 6;
            let startPage = Math.max(1, current - Math.floor((windowSize - 1) / 2));
            let endPage = Math.min(total, startPage + windowSize - 1);
            startPage = Math.max(1, endPage - windowSize + 1);
            let html = `<button class="settings-small-btn" ${current <= 1 ? 'disabled' : ''} onclick="window._invPage=${current - 1}; renderInventoryTable();">‹ Prev</button>`;
            for (let i = startPage; i <= endPage; i++) {
                html += `<button class="settings-small-btn" style="${i === current ? 'background:var(--accent); color:#fff;' : ''}" onclick="window._invPage=${i}; renderInventoryTable();">${i}</button>`;
            }
            html += `<button class="settings-small-btn" ${current >= total ? 'disabled' : ''} onclick="window._invPage=${current + 1}; renderInventoryTable();">Next ›</button>`;
            html += `<span style="color:#95a5a6; font-size:12px; margin-left:8px;">Page ${current} of ${total}</span>`;
            pager.innerHTML = html;
        }

//@fn renderInventoryTableScoped
function renderInventoryTableScoped() {
            if (viewedBranchId === 'self') { renderInventoryTable(); setTabReadOnly('inventory-list-tab', false); return; }
            const backupInv = inventory;
            inventory = scopedField('inventory', inventory);
            try { renderInventoryTable(); } finally { inventory = backupInv; }
            setTabReadOnly('inventory-list-tab', true);
        }

//@fn renderLoyaltyTiersList
function renderLoyaltyTiersList() {
            const el = document.getElementById('loyalty-tiers-list');
            if (!el) return;
            if (loyaltyTiers.length === 0) {
                el.innerHTML = `<p style="font-size:13px; color:#95a5a6; margin:0 0 8px;">No brackets yet — add one below.</p>`;
                return;
            }
            el.innerHTML = loyaltyTiers.map(t => `
                <div class="split-amounts-row" style="align-items:center; margin-bottom:6px;">
                    <input type="number" min="0" placeholder="From (KES)" value="${t.minSpend}" onchange="updateLoyaltyTier('${t.id}', 'minSpend', this.value)">
                    <input type="number" min="0" placeholder="Up to (KES, optional)" value="${t.maxSpend == null ? '' : t.maxSpend}" onchange="updateLoyaltyTier('${t.id}', 'maxSpend', this.value)">
                    <input type="number" min="0" placeholder="Tokens" value="${t.tokens}" onchange="updateLoyaltyTier('${t.id}', 'tokens', this.value)" style="max-width:90px;">
                    <button class="settings-small-btn" style="background:var(--danger); color:white;" onclick="removeLoyaltyTier('${t.id}')">✕</button>
                </div>
            `).join('');
        }

//@fn renderNewStaffRoleCheckboxes
function renderNewStaffRoleCheckboxes() {
            const container = document.getElementById('new-staff-roles');
            if (!container) return;
            container.innerHTML = ROLE_TABS.map(t => {
                // Sales Counter is a normal, unchecked-if-desired role now
                // (was hardcoded checked+disabled) — an admin creating a
                // Deliveries-only staff member can leave it unticked. Still
                // pre-checked by default (see where newStaffSelectedRoles
                // gets reset when the Add Staff form opens) so the common
                // case — most staff do need the counter — needs no extra tap.
                const checked = newStaffSelectedRoles.includes(t.id) ? 'checked' : '';
                return `<label><input type="checkbox" ${checked} onchange="toggleNewStaffRole('${t.id}', this.checked)"> ${t.label}</label>`;
            }).join('');
        }

//@fn renderPaymentAccountsListView
async function renderPaymentAccountsListView() {
            const list = document.getElementById('payment-accounts-list');
            if (!list) return;
            if (paymentAccounts.length === 0) {
                list.innerHTML = `<p style="font-size:13px; color:#95a5a6;">No payment accounts added yet.</p>`;
                renderReceivingAccountSelector();
                renderReportAccountFilter();
                return;
            }

            // Only worth fetching branch data if this shop actually has any —
            // for a standalone shop the dropdown would have nothing to offer.
            let branches = [];
            if (myBranchGroupId) {
                const data = await fetchBranchesSummary();
                if (data && data.isBranchGroup) branches = data.branches;
            }

            list.innerHTML = paymentAccounts.map(a => {
                const branchSelectHtml = branches.length === 0 ? '' : `
                    <select style="width:auto; margin:0;" onchange="setPaymentAccountBranch('${escapeJsAttr(a.id)}', this.value)">
                        <option value="">— Not connected —</option>
                        ${branches.map(b => `<option value="${escapeHtml(b.id)}" ${a.branchClientId === b.id ? 'selected' : ''}>${escapeHtml(b.label)}</option>`).join('')}
                    </select>`;
                return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--light); flex-wrap:wrap; gap:8px;">
                        <span>${escapeHtml(a.name)}</span>
                        <div style="display:flex; align-items:center; gap:8px;">
                            ${branchSelectHtml}
                            <button class="settings-small-btn" style="background:var(--danger); color:white;" onclick="removePaymentAccount('${escapeJsAttr(a.id)}')">✕</button>
                        </div>
                    </div>`;
            }).join('');

            renderReceivingAccountSelector();
            renderReportAccountFilter();
        }

//@fn renderProfitsTabScoped
function renderProfitsTabScoped() {
            if (viewedBranchId === 'self') { renderExpenses(); renderProfitReport(); setTabReadOnly('profits-tab', false); return; }
            const backupExpenses = expenses, backupSales = salesLog;
            expenses = scopedField('expenses', expenses);
            salesLog = scopedField('salesLog', salesLog);
            try { renderExpenses(); renderProfitReport(); } finally { expenses = backupExpenses; salesLog = backupSales; }
            setTabReadOnly('profits-tab', true);
        }

//@fn renderPromoOfferTargetCategories
function renderPromoOfferTargetCategories(selectedCodes) {
            const wrap = document.getElementById('offer-target-categories');
            const cats = offerAvailableCategories();
            if (cats.length === 0) {
                wrap.innerHTML = `<p style="color:#7f8c8d; font-size:12px; margin:4px;">No categories set on any inventory item yet.</p>`;
                return;
            }
            wrap.innerHTML = cats.map(cat => `
                <label class="offer-target-check">
                    <input type="checkbox" data-target-checkbox data-kind="category" data-value="${escapeHtml(cat)}" ${selectedCodes.includes('category:' + cat) ? 'checked' : ''}>
                    ${escapeHtml(cat)}
                </label>
            `).join('');
        }

//@fn renderPromoOfferTargetProducts
function renderPromoOfferTargetProducts(filterText, selectedCodes) {
            selectedCodes = selectedCodes || (window.__offerEditingSelectedCodes || []);
            window.__offerEditingSelectedCodes = selectedCodes;
            const wrap = document.getElementById('offer-target-products');
            const q = (filterText || '').trim().toLowerCase();
            const list = inventory.filter(p => !q || (p.name || '').toLowerCase().includes(q) || _codeMatches(p.code, q));
            if (list.length === 0) {
                wrap.innerHTML = `<p style="color:#7f8c8d; font-size:12px; margin:4px;">No products match.</p>`;
                return;
            }
            wrap.innerHTML = list.slice(0, 200).map(p => `
                <label class="offer-target-check">
                    <input type="checkbox" data-target-checkbox data-kind="code" data-value="${escapeHtml(p.code)}" ${selectedCodes.includes('code:' + p.code) ? 'checked' : ''}>
                    ${escapeHtml(p.name)}
                </label>
            `).join('');
        }

//@fn renderReceivingAccountSelector
function renderReceivingAccountSelector() {
            const wrap = document.getElementById('receiving-account-wrap');
            const sel = document.getElementById('receiving-account-select');
            if (!wrap || !sel) return;

            if (paymentAccounts.length === 0) {
                wrap.style.display = 'none';
                return;
            }
            wrap.style.display = 'block';
            const current = sel.value;
            sel.innerHTML = paymentAccounts.map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('');
            if (paymentAccounts.some(a => a.name === current)) sel.value = current;
        }

//@fn renderRecipeRows
function renderRecipeRows() {
            const wrap = document.getElementById('recipe-rows');
            if (!wrap) return;

            if (recipeDraft.length === 0) {
                wrap.innerHTML = `<p style="color:#7f8c8d; font-size:13px;">No ingredients added yet.</p>`;
            } else {
                wrap.innerHTML = recipeDraft.map((row, idx) => {
                    const ing = inventory.find(p => p.code === row.code);
                    const unit = ing ? (ing.unit || 'pcs') : '';
                    const hint = qtyInputHint(row.qtyPerUnit, unit);
                    return `
                    <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap;">
                        <select style="flex:2; min-width:150px;" onchange="updateRecipeRowIngredient(${idx}, this.value)">
                            ${ingredientOptionsHtml(row.code)}
                        </select>
                        <input type="text" inputmode="decimal" style="flex:1; min-width:90px;" placeholder="e.g. 1/2 or 0.5"
                            value="${escapeHtml(String(row.qtyPerUnit))}"
                            oninput="updateRecipeRowQty(${idx}, this.value)">
                        <span style="font-size:12px; color:#7f8c8d; min-width:34px;">${unitLabel(unit)}</span>
                        <span class="recipe-qty-hint" data-idx="${idx}" style="font-size:11px; color:#95a5a6; min-width:44px;">${hint && hint !== String(row.qtyPerUnit).trim() ? '= ' + escapeHtml(hint) : ''}</span>
                        <button type="button" class="remove-btn" onclick="removeRecipeRow(${idx})">✕</button>
                    </div>`;
                }).join('');
            }
            updateRecipeSummary();
        }

//@fn renderReportAccountFilter
function renderReportAccountFilter() {
            const wrap = document.getElementById('report-account-filter-wrap');
            const sel = document.getElementById('report-account-filter');
            if (!wrap || !sel) return;
            if (paymentAccounts.length === 0) {
                wrap.style.display = 'none';
                return;
            }
            wrap.style.display = 'block';
            const current = sel.value;
            sel.innerHTML = `<option value="">All Accounts</option>` +
                paymentAccounts.map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('');
            if (paymentAccounts.some(a => a.name === current)) sel.value = current;
        }

//@fn renderRestockTotals
function renderRestockTotals() {
            const total = restockDraft.reduce((sum, r) => sum + restockRowLineTotal(r), 0);
            const totalEl = document.getElementById('restock-grand-total');
            if (totalEl) totalEl.textContent = `KES ${total.toFixed(2)}`;
            document.querySelectorAll('.restock-line-total').forEach(el => {
                const rowId = parseInt(el.dataset.rowId, 10);
                const row = restockDraft.find(r => r.rowId === rowId);
                if (row) el.textContent = `KES ${restockRowLineTotal(row).toFixed(2)}`;
            });
        }

//@fn renderStockValuationSummary
function renderStockValuationSummary() {
            const openingEl = document.getElementById('stock-val-opening');
            const currentEl = document.getElementById('stock-val-current');
            const changeEl = document.getElementById('stock-val-change');
            const coverageEl = document.getElementById('stock-val-coverage');
            if (!openingEl) return; // panel not in the DOM (shouldn't happen, but cheap to guard)

            const stocked = inventory.filter(p => isStockedProduct(p));
            const withOpening = stocked.filter(p => p.openingStock);

            let openingValue = 0;
            let currentValue = 0;
            withOpening.forEach(p => {
                openingValue += (p.openingStock.qty || 0) * (p.openingStock.costPrice || 0);
                currentValue += (p.qty || 0) * (p.wholesalePrice || 0);
                if (p.dualUnit) {
                    currentValue += (p.pieceQty || 0) * (p.pieceWholesalePrice || 0);
                }
            });

            openingEl.textContent = `KES ${openingValue.toFixed(2)}`;
            currentEl.textContent = `KES ${currentValue.toFixed(2)}`;
            const change = currentValue - openingValue;
            changeEl.textContent = `${change >= 0 ? '+' : ''}KES ${change.toFixed(2)}`;
            changeEl.style.color = change > 0 ? '#27ae60' : (change < 0 ? 'var(--danger)' : 'inherit');
            coverageEl.textContent = `${withOpening.length} of ${stocked.length}`;

            // All three valuations of what's on the shelf right now. Unlike
            // Opening/Current Value above, these cover EVERY stocked item, not
            // just ones with an opening stock recorded — so they answer "what is
            // my stock worth" without needing any historical data set up first.
            const liveTotals = currentStockValueTotals();
            const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = `KES ${v.toFixed(2)}`; };
            setVal('stock-val-retail', liveTotals.retail);
            setVal('stock-val-wholesale', liveTotals.wholesale);
            setVal('stock-val-cost', liveTotals.cost);
        }

//@fn renderTillPayments
async function renderTillPayments(forceRefresh) {
            const el = document.getElementById('till-payments-list');
            if (!el) return;
            el.innerHTML = '<p class="settings-msg">Loading…</p>';
            try {
                const res = await fetch(apiUrl('/api/till-payments'));
                const data = await res.json();
                const payments = data.payments || [];
                if (payments.length === 0) {
                    el.innerHTML = '<p class="settings-hint">No direct till payments captured yet.</p>';
                    return;
                }
                el.innerHTML = payments.map(p => `
                    <div style="padding:8px 0; border-bottom:1px solid var(--light); display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
                        <div>
                            <strong>${escapeHtml(p.customerName || 'Unknown')}</strong> — KES ${p.amount.toFixed(2)}
                            <div style="font-size:12px; color:#7f8c8d;">${escapeHtml(p.phone)} · ${escapeHtml(p.transId)}${p.accountRef ? ' · Ref: ' + escapeHtml(p.accountRef) : ''}</div>
                        </div>
                        <button type="button" class="settings-small-btn" style="background:${p.matched ? '#27ae60' : ''}; ${p.matched ? 'color:white;' : ''}" onclick="markTillPaymentMatched('${escapeJsAttr(p.transId)}', ${!p.matched})">${p.matched ? '✅ Matched' : 'Mark as matched'}</button>
                    </div>`).join('');
            } catch (e) {
                el.innerHTML = '<p class="settings-msg error">' + escapeHtml(netErrText('Could not load')) + '</p>';
            }
        }

//@fn renderTrendsPieCharts
function renderTrendsPieCharts() {
            renderPaymentMethodPie();
            renderTopItemsPie();
            renderSalesVsExpensesPie();
            renderBillsStatusPie();
        }

//@fn renderVariantsModalList
function renderVariantsModalList() {
            const list = document.getElementById('variants-view-list');
            if (!list) return;
            list.innerHTML = variantsModalDraft.map(v => `
                <div style="border:1px solid var(--light); border-radius:6px; padding:10px; margin-bottom:8px;">
                    <div class="split-amounts-row">
                        <div class="form-group">
                            <label>Name</label>
                            <input type="text" value="${escapeHtml(v.name)}" oninput="updateVariantsModalField('${escapeJsAttr(v.id)}', 'name', this.value)">
                        </div>
                        <div class="form-group">
                            <label>Code ${v.dualUnit ? '(box)' : ''}</label>
                            <input type="text" value="${escapeHtml(v.code)}" oninput="updateVariantsModalField('${escapeJsAttr(v.id)}', 'code', this.value)">
                        </div>
                    </div>
                    <div class="split-amounts-row">
                        <div class="form-group">
                            <label>${v.dualUnit ? 'Box Price' : 'Retail Price'}</label>
                            <input type="number" min="0" step="0.01" value="${v.price}" oninput="updateVariantsModalField('${escapeJsAttr(v.id)}', 'price', this.value)">
                        </div>
                        <div class="form-group">
                            <label>${v.dualUnit ? 'Box Qty' : 'Qty'}</label>
                            <input type="number" min="0" step="1" value="${v.qty}" oninput="updateVariantsModalField('${escapeJsAttr(v.id)}', 'qty', this.value)">
                        </div>
                    </div>

                    <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin:8px 0 0; font-weight:normal; font-size:13px;">
                        <input type="checkbox" ${v.dualUnit ? 'checked' : ''} onchange="updateVariantsModalField('${escapeJsAttr(v.id)}', 'dualUnit', this.checked); renderVariantsModalList();" style="width:auto;">
                        📦➡️ Also sold individually (whole box, or by the piece)
                    </label>
                    ${v.dualUnit ? `
                    <div style="padding:10px; background:#f8f9fa; border-radius:6px; margin-top:8px;">
                        <div class="split-amounts-row">
                            <div class="form-group">
                                <label>Pieces Per Box</label>
                                <input type="number" min="1" step="1" value="${v.unitsPerBox || ''}" oninput="updateVariantsModalField('${escapeJsAttr(v.id)}', 'unitsPerBox', this.value)">
                            </div>
                            <div class="form-group">
                                <label>Piece Code</label>
                                <input type="text" value="${escapeHtml(v.pieceCode || '')}" oninput="updateVariantsModalField('${escapeJsAttr(v.id)}', 'pieceCode', this.value)">
                            </div>
                        </div>
                        <div class="split-amounts-row">
                            <div class="form-group">
                                <label>Piece Price</label>
                                <input type="number" min="0" step="0.01" value="${v.piecePrice || 0}" oninput="updateVariantsModalField('${escapeJsAttr(v.id)}', 'piecePrice', this.value)">
                            </div>
                            <div class="form-group">
                                <label>Piece Qty <span style="font-weight:normal; color:#7f8c8d;">(loose pieces)</span></label>
                                <input type="number" min="0" step="1" value="${v.pieceQty || 0}" oninput="updateVariantsModalField('${escapeJsAttr(v.id)}', 'pieceQty', this.value)">
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Piece Wholesale/Cost <span style="font-weight:normal; color:#7f8c8d;">optional — defaults to Box Wholesale ÷ Pieces Per Box</span></label>
                            <input type="number" min="0" step="0.01" value="${v.pieceWholesalePrice || ''}" oninput="updateVariantsModalField('${escapeJsAttr(v.id)}', 'pieceWholesalePrice', this.value)">
                        </div>
                    </div>` : ''}

                    <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                        <button class="settings-small-btn" style="background:var(--danger); color:white;" onclick="removeVariantsModalRow('${escapeJsAttr(v.id)}')">✕ Remove</button>
                    </div>
                </div>`).join('') + `<button type="button" class="settings-small-btn" onclick="addVariantsModalRow()">+ Add Variant</button>`;
        }

//@fn reportFilenameBase
function reportFilenameBase() {
            const titleLine = (lastReportText || '').split('\n')[1] || 'report';
            const slug = titleLine.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
            return `${slug}-${todayDateString()}`;
        }

//@fn reprintExchangeReceipt
function reprintExchangeReceipt(returnId) {
            const record = returns.find(r => r.id === returnId);
            if (!record) { showToast('Could not find that exchange.', true); return; }
            const sale = salesLog.find(s => s.id === record.linkedSaleId);
            printExchangeReceipt(record, sale || null);
        }

//@fn requestBulkDeclareOpeningStock
function requestBulkDeclareOpeningStock() {
            const stocked = inventory.filter(p => isStockedProduct(p));
            const undeclared = stocked.filter(p => !p.openingStock);
            if (undeclared.length === 0) { showToast('Every item already has an opening stock recorded.'); return; }
            if (!confirm(`Declare opening stock for all ${undeclared.length} item(s) that don't have one yet? Each item's CURRENT quantity and cost price will be recorded as its opening stock, dated today (${todayLocalDateStr()}). This can't be edited afterward — only fine for items where today's stock level really is what you want as the historical baseline.`)) return;
            adminPwModalPurpose = 'bulk-declare-opening-stock';
            showAdminPwModal(
                'Management Access',
                'Enter the management password to bulk-declare opening stock',
                'No management password is set yet. Create one now to protect this action.'
            );
        }

//@fn requestEditOpeningStock
function requestEditOpeningStock(code) {
            const product = inventory.find(p => p.code === code);
            if (!product || !product.openingStock) { showToast('No opening stock recorded for this item yet.', true); return; }
            pendingEditOpeningStockCode = code;
            adminPwModalPurpose = 'edit-opening-stock';
            showAdminPwModal(
                'Management Access',
                'Enter the management password to correct this item\'s opening stock',
                'No management password is set yet. Create one now to protect this action.'
            );
        }

//@fn requestReduceStock
function requestReduceStock(code, newQty) {
            const product = inventory.find(p => p.code === code);
            if (!product) return;
            pendingReduceStockCode = code;
            pendingReduceStockQty = newQty;
            adminPwModalPurpose = 'reduce-stock';
            showAdminPwModal(
                'Management Access',
                `Enter the management password to reduce stock for "${product.name}"`,
                'No management password is set yet. Create one now to protect stock reductions.'
            );
        }

//@fn requestResetExceptInventory
function requestResetExceptInventory() {
            const txCount = salesLog.length + bills.length;
            if (txCount === 0) { showToast('There are no sales or bills to clear.'); return; }
            const stocked = inventory.filter(p => isStockedProduct(p));
            const withOpening = stocked.filter(p => p.openingStock).length;
            const withoutOpening = stocked.length - withOpening;
            if (!confirm(`Delete all ${salesLog.length} sale(s) and ${bills.length} bill(s), and the stock movement log, on every device? ${withOpening} item(s) with an opening stock recorded will have their quantity put back to that figure.${withoutOpening ? ` ${withoutOpening} item(s) with no opening stock recorded will keep their current quantity as-is.` : ''} This cannot be undone.`)) return;
            adminPwModalPurpose = 'reset-except-inventory';
            showAdminPwModal(
                'Management Access',
                'Enter the management password to reset sales & stock history',
                'No management password is set yet. Create one now to protect this action.'
            );
        }

//@fn requestSetOpeningStock
function requestSetOpeningStock(code) {
            const product = inventory.find(p => p.code === code);
            if (!product) { showToast('Could not find that item.', true); return; }
            if (product.openingStock) { showToast('Opening stock is already set for this item.', true); return; }

            const qtyRaw = prompt(`Opening stock quantity for "${product.name}" (in ${unitLabel(product.unit)}):`, String(product.qty || 0));
            if (qtyRaw === null) return;
            const qty = parseQtyInput(qtyRaw);
            if (isNaN(qty) || qty < 0) {
                showToast('Enter a valid quantity.', true);
                return;
            }

            const costRaw = prompt(`Cost price per ${unitLabel(product.unit)} at that time (KES):`, String(product.wholesalePrice || 0));
            if (costRaw === null) return;
            const costPrice = parseFloat(costRaw);
            if (isNaN(costPrice) || costPrice < 0) {
                showToast('Enter a valid cost price.', true);
                return;
            }

            const dateRaw = prompt('Date (YYYY-MM-DD) — leave as today if unsure:', todayLocalDateStr());
            if (dateRaw === null) return;
            const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw.trim()) ? dateRaw.trim() : todayLocalDateStr();

            product.openingStock = { qty, costPrice, date, setBy: activeServerName() };
            safeSetItem('pos_inventory', JSON.stringify(inventory));
            queuePush();
            renderInventoryTable();
            showToast(`Opening stock set for "${product.name}".`);
        }

//@fn resetEtimsConfig
async function resetEtimsConfig() {
            if (!confirm('Clear this shop’s KRA eTIMS registration? Receipts will stop showing eTIMS information until it’s registered again.')) return;
            try {
                const res = await fetch(apiUrl('/api/etims-config'), { method: 'DELETE' });
                if (!res.ok) throw new Error('reset failed');
                showToast('eTIMS registration cleared.');
                checkEtimsStatus();
                refreshEtimsReceiptInfo();
            } catch (e) {
                showToast('Could not clear the registration — try again.', true);
            }
        }

//@fn resetExchangeState
function resetExchangeState() {
            exchangeReplacementItems = [];
            exchangeCreditValueDirty = false;
            exchangeTopupMethod = 'cash';
            const creditInput = document.getElementById('exchange-credit-value-input');
            if (creditInput) creditInput.value = '';
            const searchInput = document.getElementById('exchange-item-search');
            if (searchInput) searchInput.value = '';
            const resultsBox = document.getElementById('exchange-item-search-results');
            if (resultsBox) resultsBox.style.display = 'none';
            const splitCash = document.getElementById('exchange-split-cash-input');
            const splitMpesa = document.getElementById('exchange-split-mpesa-input');
            if (splitCash) splitCash.value = '';
            if (splitMpesa) splitMpesa.value = '';
            const mpesaCode = document.getElementById('exchange-mpesa-code-input');
            if (mpesaCode) mpesaCode.value = '';
            document.getElementById('exchange-topup-cash-btn').classList.add('active');
            document.getElementById('exchange-topup-mpesa-btn').classList.remove('active');
            document.getElementById('exchange-topup-split-btn').classList.remove('active');
            document.getElementById('exchange-topup-split-inputs').style.display = 'none';
            renderExchangeItemsTable();
            renderExchangeBalance();
        }

//@fn resetImageSearchConfig
async function resetImageSearchConfig() {
            if (!confirm('Turn off auto product images? New items will need a manually added photo until you save a key again.')) return;
            try {
                await fetch(apiUrl('/api/image-search'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pixabayApiKey: '' }),
                });
            } catch (e) { /* fall through — status check below reflects reality either way */ }
            checkImageSearchStatus();
        }

//@fn resetMpesaState
function resetMpesaState() {
            if (mpesaPollTimer) clearInterval(mpesaPollTimer);
            if (mpesaTimeoutTimer) clearTimeout(mpesaTimeoutTimer);
            mpesaPollTimer = null;
            mpesaTimeoutTimer = null;
            mpesaCheckoutRequestId = null;
            mpesaConfirmedReceipt = null;
            const btn = document.getElementById('mpesa-send-btn');
            if (btn) { btn.disabled = false; btn.textContent = '📲 Send M-Pesa Prompt'; }
            setMpesaStatus('', '');
        }

//@fn resetPromoOfferModalFields
function resetPromoOfferModalFields() {
            document.getElementById('offer-edit-id').value = '';
            document.getElementById('offer-name-input').value = '';
            document.getElementById('offer-type-select').value = 'bogo';
            document.getElementById('offer-bogo-buyqty').value = '';
            document.getElementById('offer-bogo-freeqty').value = '';
            document.getElementById('offer-bogo-discount-pct').value = '100';
            document.getElementById('offer-percent-input').value = '';
            document.getElementById('offer-flat-amount').value = '';
            document.getElementById('offer-flat-minqty').value = '1';
            document.getElementById('offer-bundle-qty').value = '';
            document.getElementById('offer-bundle-price').value = '';
            document.getElementById('promo-offer-modal-error').textContent = '';
            document.getElementById('offer-target-product-search').value = '';
            window.__offerEditingSelectedCodes = [];
            onPromoOfferTypeChange();
            setPromoOfferScope('all');
            renderPromoOfferTargetCategories([]);
            renderPromoOfferTargetProducts('', []);
        }

//@fn resetReturnForm
function resetReturnForm() {
            selectedReturnItem = null;
            document.getElementById('return-ref-input').value = '';
            document.getElementById('return-ref-status').textContent = '';
            document.getElementById('return-ref-items-panel').style.display = 'none';
            document.getElementById('return-item-search').value = '';
            document.getElementById('return-selected-item').textContent = '';
            document.getElementById('return-qty-input').value = '1';
            document.getElementById('return-condition-select').value = 'good';
            document.getElementById('return-reason-select').value = 'Damaged';
            document.getElementById('return-reason-other-input').value = '';
            document.getElementById('return-reason-other-input').style.display = 'none';
            document.getElementById('return-topup-amount-input').value = '';
            document.getElementById('return-customer-name-input').value = '';
            document.getElementById('return-customer-phone-input').value = '';
            document.getElementById('return-save-error').textContent = '';
            updateReturnConditionHint();
            resetExchangeState();
            resetUnavailableExchangeForm();
            setReturnMode('exchange');
        }

//@fn resetSmsConfig
async function resetSmsConfig() {
            if (!confirm('Turn off SMS? Automatic thank-you texts will stop until you save an account again.')) return;
            try {
                await fetch(apiUrl('/api/sms-config'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        atUsername: '', atApiKey: '', mobitechApiKey: '', mobitechSenderName: '',
                        celcomApiKey: '', celcomPartnerId: '', celcomShortcode: '',
                        advantaApiKey: '', advantaPartnerId: '', advantaShortcode: '',
                        talksasaApiKey: '', talksasaSenderId: '',
                    }),
                });
            } catch (e) { /* fall through — status check below reflects reality either way */ }
            checkSmsStatus();
        }

//@fn resetUnavailableExchangeForm
function resetUnavailableExchangeForm() {
            selectedUnavailableItem = null;
            const form = document.getElementById('exchange-unavailable-form');
            if (form) form.style.display = 'none';
            const searchEl = document.getElementById('exchange-unavailable-item-search');
            if (searchEl) searchEl.value = '';
            const selectedEl = document.getElementById('exchange-unavailable-selected');
            if (selectedEl) selectedEl.textContent = '';
            const dateEl = document.getElementById('exchange-unavailable-date-input');
            if (dateEl) dateEl.value = '';
            const errEl = document.getElementById('exchange-unavailable-error');
            if (errEl) errEl.textContent = '';
        }

//@fn restockRowLineTotal
function restockRowLineTotal(row) {
            const qty = parseQtyInput(row.qty) || 0;
            const cost = parseFloat(row.cost) || 0;
            return qty * cost;
        }

//@fn restoreStockForSaleUnit
function restoreStockForSaleUnit(product, qty, saleMode) {
            if (product.dualUnit && saleMode === 'piece') {
                product.pieceQty = (product.pieceQty || 0) + qty;
                logStockMovement(product.code, product.name, qty, 'Sale void', 'pieceQty');
            } else {
                product.qty = (product.qty || 0) + qty;
                logStockMovement(product.code, product.name, qty, 'Sale void', 'qty');
            }
        }

//@fn retakePhoto
function retakePhoto() {
            currentCapturedImageBase64 = null;
            document.getElementById('photo-preview-element').src =
                "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' fill='%23eee'/></svg>";
            const fileInput = document.getElementById('image-file-input');
            if (fileInput) fileInput.value = '';
        }

//@fn round2
function round2(n) { return Math.round((n || 0) * 100) / 100; }

//@fn runBackgroundCameraScanTick
async function runBackgroundCameraScanTick(video) {
            if (!cameraScanStream || !video.videoWidth) return;
            try {
                // Draw the current frame down to the off-screen canvas, then
                // grayscale + boost contrast on it before handing it to the
                // detector — see the comment in startBackgroundCameraScan()
                // for why. Runs every tick; at this frame's typical size
                // (bounded well below the camera's own capture resolution)
                // it's cheap enough not to fight the 180ms throttle above.
                const w = cameraScanCanvas.width = Math.min(video.videoWidth, 1280);
                const h = cameraScanCanvas.height = Math.round(w * (video.videoHeight / video.videoWidth));
                const ctx = cameraScanCanvasCtx;
                ctx.drawImage(video, 0, 0, w, h);

                const imageData = ctx.getImageData(0, 0, w, h);
                const d = imageData.data;
                const contrast = 1.35; // light boost — enough to sharpen bar edges without blowing out a well-lit frame
                const intercept = 128 * (1 - contrast);
                for (let i = 0; i < d.length; i += 4) {
                    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                    const adjusted = Math.max(0, Math.min(255, gray * contrast + intercept));
                    d[i] = d[i + 1] = d[i + 2] = adjusted;
                }
                ctx.putImageData(imageData, 0, 0);

                const barcodes = await cameraScanDetector.detect(cameraScanCanvas);
                if (barcodes.length > 0) {
                    const value = barcodes[0].rawValue;
                    const now = Date.now();
                    // Same code detected again within 2s is almost certainly
                    // the same physical barcode still sitting in view, not a
                    // second deliberate scan — ignored so it can't add the
                    // item twice just because it wasn't moved out of frame
                    // immediately.
                    if (value !== lastCameraScanValue || now - lastCameraScanTime > 2000) {
                        lastCameraScanValue = value;
                        lastCameraScanTime = now;
                        handleBarcodeScan(value);
                    }
                }
            } catch (e) {
                // Transient detection errors (e.g. a frame mid-transition) —
                // just try again on the next tick rather than surfacing this.
            }
        }

//@fn runQueuedSystemPrint
function runQueuedSystemPrint(setupAndPrintFn) {
            return new Promise((resolve) => {
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    window.removeEventListener('afterprint', finish);
                    clearTimeout(safety);
                    resolve();
                };
                // Some phones never fire 'afterprint': without a limit the next receipt in the queue waited behind this one for ever.
                const safety = setTimeout(finish, window.__printSafetyMs || 20000);
                window.addEventListener('afterprint', finish);
                try { fitReceiptGrids(); } catch (e) { /* the estimate stands */ }
                setupAndPrintFn();
            });
        }

//@fn runScanModalTick
async function runScanModalTick(video) {
            if (!scanModalStream || !video.videoWidth) return;
            try {
                const value = await detectOnceFromScanModal(video);
                if (value) {
                    const now = Date.now();
                    if (value !== scanModalLastValue || now - scanModalLastTime > 1500) {
                        scanModalLastValue = value;
                        scanModalLastTime = now;
                        setBarcodeScanModalStatus(`Scanned: ${value}`);
                        completeBarcodeScanModal(value);
                    }
                }
            } catch (e) {
                // Transient decode error on this frame — next tick retries.
            }
        }

//@fn safeJSONParse
function safeJSONParse(key, fallback) {
            const raw = localStorage.getItem(key);
            if (raw === null || raw === undefined) return fallback;
            try {
                return JSON.parse(raw);
            } catch (e) {
                console.error('Corrupted localStorage value for', key, '— trying its local backup.', e);
                try {
                    const backupRaw = localStorage.getItem(key + ':prev');
                    if (backupRaw !== null) {
                        const recovered = JSON.parse(backupRaw);
                        recoveredStorageKeys.push(key);
                        // Promote the backup back into the live slot so the
                        // recovery sticks even if this key never gets re-saved
                        // again this session.
                        try { localStorage.setItem(key, backupRaw); } catch (e2) { /* best-effort */ }
                        return recovered;
                    }
                } catch (e2) {
                    // The backup itself is corrupted too — fall through to default.
                }
                corruptedStorageKeys.push(key);
                return fallback;
            }
        }

//@fn safeSetItem
function safeSetItem(key, value) {
            try {
                // Keep one generation of local backup for this key, best-effort, so
                // a corrupted write can self-heal from the last-known-good value
                // (see safeJSONParse's recovery step below) instead of falling all
                // the way back to blank. Never lets a backup-write problem block
                // the real write that matters.
                if (typeof value === 'string' && value.length < SAFE_SETITEM_BACKUP_SIZE_CAP) {
                    try {
                        const current = localStorage.getItem(key);
                        if (current !== null) localStorage.setItem(key + ':prev', current);
                    } catch (e) { /* best-effort — never block the real write over this */ }
                }

                localStorage.setItem(key, value);
                return true;
            } catch (e) {
                console.error('localStorage write failed for', key, e);
                // No message for the cashier: the device archives its oldest history by itself and the change is saved again
                // straight afterwards (the arrays are always written whole). Only an ADMIN is told, and only if that fails too.
                try {
                    if (window.storageAutoArchive) {
                        window.storageAutoArchive('write-failed').then(function () {
                            try { localStorage.setItem(key, value); } catch (e2) { /* still no room: the admin has been told */ }
                        });
                    }
                } catch (e3) { /* never let housekeeping break a sale */ }
                return false;
            }
        }

//@fn saleHasServices
function saleHasServices(saleRecord) {
            return Array.isArray(saleRecord.items) && saleRecord.items.some(i => i.isService);
        }

//@fn salesTablePeriodLabel
function salesTablePeriodLabel(range) {
            const fmt = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            return range.from === range.to ? fmt(range.from) : `${fmt(range.from)} — ${fmt(range.to)}`;
        }

//@fn sanitizeBarcodeValue
function sanitizeBarcodeValue(raw) {
            return (raw || '').toUpperCase().replace(/[^A-Z0-9 \-.]/g, '');
        }

//@fn saveAiCaptureOwnKey
async function saveAiCaptureOwnKey() {
            const msgEl = document.getElementById('ai-capture-own-key-msg');
            const input = document.getElementById('ai-capture-gemini-key-input');
            const labelInput = document.getElementById('ai-capture-gemini-key-label-input');
            const geminiApiKey = input.value.trim();
            if (!geminiApiKey) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = 'Enter your Gemini API key.';
                return;
            }
            try {
                const res = await fetch(apiUrl('/api/ai-capture-list'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'add', geminiApiKey, label: labelInput.value.trim() }),
                });
                const data = await res.json();
                if (!res.ok || data.error) throw new Error(data.error || 'save failed');
                msgEl.className = 'settings-msg success';
                msgEl.textContent = 'Saved — this device now tries your key(s) first.';
                input.value = '';
                labelInput.value = '';
                checkAiCaptureStatus();
            } catch (e) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = e.message === 'save failed' ? 'Could not save — try again.' : (e.message || 'Could not save — try again.');
            }
        }

//@fn saveAttendanceLocal
function saveAttendanceLocal() {
            safeSetItem('pos_attendance_roster', JSON.stringify(attendanceRoster));
            safeSetItem('pos_attendance_log', JSON.stringify(attendanceLog));
        }

//@fn saveContract
function saveContract() {
            const name = document.getElementById('contract-name-input').value.trim();
            const phone = document.getElementById('contract-phone-input').value.trim();
            const errorEl = document.getElementById('contract-form-error');
            errorEl.textContent = '';

            if (!name) {
                errorEl.textContent = 'Please enter a name.';
                return;
            }

            const validRows = contractDraft.filter(r => r.name.trim() && parseFloat(r.qty) > 0);
            if (validRows.length === 0) {
                errorEl.textContent = 'Add at least one item with a name and quantity.';
                return;
            }

            const lineItems = [];
            for (const r of validRows) {
                const product = contractRowProduct(r);
                if (!product) {
                    errorEl.textContent = `"${r.name}" was not found in inventory — add it first from 📦 Add New Items.`;
                    return;
                }
                const qty = parseFloat(r.qty);
                if (qty > (product.qty || 0)) {
                    errorEl.textContent = `Only ${formatQtyDisplay(product.qty, product.unit)} ${unitLabel(product.unit)} of "${product.name}" in stock.`;
                    return;
                }
                const price = contractRowUnitPrice(r);
                if (activeContractType === 'wholesale' && (isNaN(price) || price <= 0)) {
                    errorEl.textContent = `Please enter a valid price given for "${product.name}".`;
                    return;
                }
                lineItems.push({ code: product.code, name: product.name, unit: product.unit || 'pcs', qty, price });
            }

            // Deduct stock now — it's physically leaving the shop with the contract holder.
            lineItems.forEach(li => {
                const product = inventory.find(p => p.code === li.code);
                if (product) product.qty = Math.max(0, (product.qty || 0) - li.qty);
            });
            safeSetItem('pos_inventory', JSON.stringify(inventory));

            let contract = activeContractId ? contracts.find(c => c.id === activeContractId) : null;
            if (!contract) {
                contract = { id: genSaleId(), name, phone, type: activeContractType, createdAt: new Date().toISOString(), items: {}, visits: [] };
                contracts.push(contract);
            } else {
                // Keep the contract's own name/phone/type as the source of truth (this
                // form visit might just be re-typed slightly differently).
                contract.phone = contract.phone || phone;
            }

            contract.visits.push({ date: new Date().toISOString(), items: lineItems.map(li => ({ code: li.code, name: li.name, qty: li.qty, price: li.price })) });
            lineItems.forEach(li => {
                if (!contract.items[li.code]) {
                    contract.items[li.code] = { code: li.code, name: li.name, unit: li.unit, price: li.price, qtyCarried: 0, qtyReturned: 0, qtySettled: 0 };
                }
                const agg = contract.items[li.code];
                agg.qtyCarried += li.qty;
                agg.price = li.price; // most recent negotiated/shop price
            });

            safeSetItem('pos_contracts', JSON.stringify(contracts));
            queuePush();

            renderInventoryTable();
            renderNotifications();
            renderContractsTab();
            renderBillsTab();
            showToast(`Contract saved for ${contract.name} — stock deducted.`);

            printContractCarryNote(contract, lineItems);

            // Reset form for the next contract/visit
            contractDraft = [];
            addContractRow();
            document.getElementById('contract-name-input').value = '';
            document.getElementById('contract-phone-input').value = '';
            startNewContract();
        }

//@fn saveDebtsLocal
function saveDebtsLocal() { safeSetItem('pos_debts', JSON.stringify(debts)); }

//@fn saveGatewayForcedProvider
async function saveGatewayForcedProvider(value) {
            try {
                await fetch(apiUrl('/api/gateway-config'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ provider: value }),
                });
                checkPaymentGatewayStatus();
            } catch (e) {
                // Silent — the status readout above just won't reflect the change yet.
            }
        }

//@fn saveGatewayKcbConfig
async function saveGatewayKcbConfig() {
            const msgEl = document.getElementById('gateway-kcb-msg');
            const payload = {
                kcbEnv: document.getElementById('gateway-kcb-env-input').value,
                kcbConsumerKey: document.getElementById('gateway-kcb-consumer-key-input').value.trim(),
                kcbConsumerSecret: document.getElementById('gateway-kcb-consumer-secret-input').value.trim(),
                kcbOrgShortCode: document.getElementById('gateway-kcb-org-shortcode-input').value.trim(),
                kcbOrgPassKey: document.getElementById('gateway-kcb-org-passkey-input').value.trim(),
                kcbSharedShortCode: document.getElementById('gateway-kcb-shared-shortcode-input').checked,
            };
            if (!payload.kcbConsumerKey || !payload.kcbConsumerSecret) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = 'Consumer Key and Consumer Secret are both required.';
                return;
            }
            if (!payload.kcbOrgShortCode) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = 'Enter the KCB Till Number provisioned for this shop — there’s no shared/default code that works for every merchant.';
                return;
            }
            // Only send text fields the admin actually typed something into — an
            // empty field here means "leave whatever's already saved alone,"
            // not "erase it." The server merges by field, so this is safe.
            // kcbSharedShortCode is a checkbox, always sent either way.
            ['kcbEnv', 'kcbConsumerKey', 'kcbConsumerSecret', 'kcbOrgShortCode', 'kcbOrgPassKey'].forEach((k) => {
                if (payload[k] === '') delete payload[k];
            });

            try {
                const res = await fetch(apiUrl('/api/gateway-config'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                if (!res.ok) throw new Error('save failed');
                msgEl.className = 'settings-msg success';
                msgEl.textContent = 'Saved.';
                document.getElementById('gateway-kcb-consumer-secret-input').value = '';
                document.getElementById('gateway-kcb-org-passkey-input').value = '';
                checkPaymentGatewayStatus();
            } catch (e) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = 'Could not save — try again.';
            }
        }

//@fn saveGatewayPaystackKey
async function saveGatewayPaystackKey() {
            const input = document.getElementById('gateway-paystack-key-input');
            const msgEl = document.getElementById('gateway-paystack-msg');
            const key = input.value.trim();
            if (!key) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = 'Enter a key first.';
                return;
            }
            try {
                const res = await fetch(apiUrl('/api/gateway-config'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paystackSecretKey: key }),
                });
                if (!res.ok) throw new Error('save failed');
                msgEl.className = 'settings-msg success';
                msgEl.textContent = 'Saved.';
                input.value = '';
                checkPaymentGatewayStatus();
            } catch (e) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = 'Could not save — try again.';
            }
        }

//@fn saveGatewayPaywaveConfig
async function saveGatewayPaywaveConfig() {
            const msgEl = document.getElementById('gateway-paywave-msg');
            const payload = {
                paywaveApiKey: document.getElementById('gateway-paywave-api-key-input').value.trim(),
                paywaveEmail: document.getElementById('gateway-paywave-email-input').value.trim(),
            };
            if (!payload.paywaveApiKey || !payload.paywaveEmail) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = 'Both the API key and the account email are required.';
                return;
            }
            try {
                const res = await fetch(apiUrl('/api/gateway-config'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                if (!res.ok) throw new Error('save failed');
                msgEl.className = 'settings-msg success';
                msgEl.textContent = 'Saved.';
                document.getElementById('gateway-paywave-api-key-input').value = '';
                checkPaymentGatewayStatus();
            } catch (e) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = 'Could not save — try again.';
            }
        }

//@fn saveImageSearchConfig
async function saveImageSearchConfig() {
            const msgEl = document.getElementById('image-search-msg');
            const apiKey = document.getElementById('image-search-api-key-input').value.trim();
            if (!apiKey) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = 'Enter your Pixabay API key.';
                return;
            }
            try {
                const res = await fetch(apiUrl('/api/image-search'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pixabayApiKey: apiKey }),
                });
                if (!res.ok) throw new Error('save failed');
                msgEl.className = 'settings-msg success';
                msgEl.textContent = 'Saved.';
                document.getElementById('image-search-api-key-input').value = '';
                checkImageSearchStatus();
            } catch (e) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = 'Could not save — try again.';
            }
        }

//@fn saveLicenseCheckpoint
function saveLicenseCheckpoint(data) {
            try {
                safeSetItem('pos_license_checkpoint', JSON.stringify({
                    serverNow: data.serverNow,
                    remainingMs: data.remainingMs,
                    type: data.type,
                    valid: data.valid,
                    reason: data.reason,
                    // Our OWN wall-clock reading at the moment the server answered —
                    // this is what lets a later offline estimate detect a rewound
                    // system clock (see estimateLicenseOffline): if a future Date.now()
                    // comes back EARLIER than this, the clock has been wound back,
                    // since real time cannot move backward.
                    checkedAtLocal: Date.now(),
                }));
            } catch (e) { /* storage full or unavailable — offline estimate just won't have a checkpoint */ }
        }

//@fn saveNotifiedToday
function saveNotifiedToday(record) {
            try { safeSetItem(NOTIF_SEEN_KEY, JSON.stringify(record)); } catch (e) { /* quota — not fatal */ }
        }

//@fn saveOffersLocal
function saveOffersLocal() {
            safeSetItem('pos_offers', JSON.stringify(offers));
        }

//@fn savePrintRoutingRule
async function savePrintRoutingRule() {
            const trigger = document.getElementById('routing-rule-trigger').value;
            const sourceStation = document.getElementById('routing-rule-source').value;
            const destinations = Array.from(document.querySelectorAll('.routing-rule-dest:checked')).map(el => el.value);
            if (!destinations.length) {
                showToast('Pick at least one destination.', true);
                return;
            }
            printRoutingRules.push({
                id: 'rule_' + Date.now().toString(36),
                trigger, sourceStation, destinations, active: true,
            });
            await persistPrintRoutingRules();
            closeAddPrintRoutingRule();
            renderPrintRoutingRulesList();
        }

//@fn saveReturnOrExchange
function saveReturnOrExchange() {
            if (returnMode === 'exchange') saveExchange();
            else saveSimpleReturn();
        }

//@fn saveSmsConfig
async function saveSmsConfig() {
            const msgEl = document.getElementById('sms-config-msg');
            const payload = { provider: smsProviderChoice };
            if (smsProviderChoice === 'mobitech') {
                const apiKey = document.getElementById('sms-mobitech-apikey-input').value.trim();
                const senderName = document.getElementById('sms-mobitech-sender-input').value.trim();
                if (!apiKey || !senderName) {
                    msgEl.className = 'settings-msg error';
                    msgEl.textContent = 'Enter both your Mobitech API key and Sender Name.';
                    return;
                }
                payload.mobitechApiKey = apiKey;
                payload.mobitechSenderName = senderName;
            } else if (smsProviderChoice === 'celcom') {
                const apiKey = document.getElementById('sms-celcom-apikey-input').value.trim();
                const partnerId = document.getElementById('sms-celcom-partnerid-input').value.trim();
                const shortcode = document.getElementById('sms-celcom-shortcode-input').value.trim();
                if (!apiKey || !partnerId || !shortcode) {
                    msgEl.className = 'settings-msg error';
                    msgEl.textContent = 'Enter your Celcom Africa API key, Partner ID, and Shortcode.';
                    return;
                }
                payload.celcomApiKey = apiKey;
                payload.celcomPartnerId = partnerId;
                payload.celcomShortcode = shortcode;
            } else if (smsProviderChoice === 'advanta') {
                const apiKey = document.getElementById('sms-advanta-apikey-input').value.trim();
                const partnerId = document.getElementById('sms-advanta-partnerid-input').value.trim();
                const shortcode = document.getElementById('sms-advanta-shortcode-input').value.trim();
                if (!apiKey || !partnerId || !shortcode) {
                    msgEl.className = 'settings-msg error';
                    msgEl.textContent = 'Enter your Advanta SMS API key, Partner ID, and Shortcode.';
                    return;
                }
                payload.advantaApiKey = apiKey;
                payload.advantaPartnerId = partnerId;
                payload.advantaShortcode = shortcode;
            } else if (smsProviderChoice === 'talksasa') {
                const apiKey = document.getElementById('sms-talksasa-apikey-input').value.trim();
                const senderId = document.getElementById('sms-talksasa-senderid-input').value.trim();
                if (!apiKey || !senderId) {
                    msgEl.className = 'settings-msg error';
                    msgEl.textContent = 'Enter both your TalkSasa API key and Sender ID.';
                    return;
                }
                payload.talksasaApiKey = apiKey;
                payload.talksasaSenderId = senderId;
            } else {
                const username = document.getElementById('sms-at-username-input').value.trim();
                const apiKey = document.getElementById('sms-at-apikey-input').value.trim();
                if (!username || !apiKey) {
                    msgEl.className = 'settings-msg error';
                    msgEl.textContent = 'Enter both your Africa’s Talking username and API key.';
                    return;
                }
                payload.atUsername = username;
                payload.atApiKey = apiKey;
            }
            try {
                const res = await fetch(apiUrl('/api/sms-config'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                if (!res.ok) throw new Error('save failed');
                msgEl.className = 'settings-msg success';
                msgEl.textContent = 'Saved.';
                ['sms-at-username-input', 'sms-at-apikey-input', 'sms-mobitech-apikey-input', 'sms-mobitech-sender-input',
                 'sms-celcom-apikey-input', 'sms-celcom-partnerid-input', 'sms-celcom-shortcode-input',
                 'sms-advanta-apikey-input', 'sms-advanta-partnerid-input', 'sms-advanta-shortcode-input',
                 'sms-talksasa-apikey-input', 'sms-talksasa-senderid-input'].forEach((id) => {
                    const el = document.getElementById(id);
                    if (el) el.value = '';
                });
                checkSmsStatus();
            } catch (e) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = 'Could not save — try again.';
            }
        }

//@fn saveThankYouTemplate
async function saveThankYouTemplate(value) {
            smsThankYouTemplate = value.trim();
            try {
                await fetch(apiUrl('/api/sms-config'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ thankYouTemplate: smsThankYouTemplate }),
                });
            } catch (e) { /* quiet — will just re-save next time Settings loads */ }
        }

//@fn saveVariantsModal
function saveVariantsModal() {
            const product = inventory.find(p => p.code === variantsModalCode);
            if (!product) return;
            const errEl = document.getElementById('variants-view-modal-error');

            const cleanVariants = [];
            const seenCodes = new Set();
            for (const v of variantsModalDraft) {
                const vName = String(v.name).trim();
                if (!vName) { errEl.textContent = 'Every variant needs a name.'; return; }
                const vPrice = parseFloat(v.price);
                if (isNaN(vPrice) || vPrice < 0) { errEl.textContent = `Enter a valid price for "${vName}".`; return; }
                const vQty = parseInt(v.qty, 10);
                if (isNaN(vQty) || vQty < 0) { errEl.textContent = `Enter a valid quantity for "${vName}".`; return; }
                const vCode = String(v.code).trim() || `${product.code}-${v.id.split('-').pop()}`.toUpperCase();

                const codesToCheck = [vCode];
                let vDualUnit = false, vUnitsPerBox = null, vPieceCode = null, vPiecePrice = 0, vPieceWholesalePrice = 0, vPieceQty = 0;
                if (v.dualUnit) {
                    vDualUnit = true;
                    vUnitsPerBox = parseInt(v.unitsPerBox, 10);
                    if (!vUnitsPerBox || vUnitsPerBox < 1) { errEl.textContent = `Enter valid pieces-per-box for "${vName}".`; return; }
                    vPiecePrice = parseFloat(v.piecePrice);
                    if (isNaN(vPiecePrice) || vPiecePrice < 0) { errEl.textContent = `Enter a valid piece price for "${vName}".`; return; }
                    const vPieceQtyParsed = parseInt(v.pieceQty, 10);
                    vPieceQty = isNaN(vPieceQtyParsed) ? 0 : Math.max(0, vPieceQtyParsed);
                    vPieceWholesalePrice = v.pieceWholesalePrice !== '' && v.pieceWholesalePrice != null
                        ? parseFloat(v.pieceWholesalePrice) || 0
                        : (parseFloat(v.wholesalePrice) || 0) / vUnitsPerBox;
                    vPieceCode = String(v.pieceCode || '').trim() || `${vCode}-PC`;
                    codesToCheck.push(vPieceCode);
                }

                for (const checkCode of codesToCheck) {
                    if (seenCodes.has(checkCode.toLowerCase())) { errEl.textContent = `Two codes collide on "${checkCode}" — codes must be unique.`; return; }
                    const collidesElsewhere = inventory.some(p => p.code !== product.code && (
                        p.code.toLowerCase() === checkCode.toLowerCase() ||
                        (p.pieceCode && p.pieceCode.toLowerCase() === checkCode.toLowerCase()) ||
                        (Array.isArray(p.variants) && p.variants.some(ev => ev.id !== v.id && (ev.code.toLowerCase() === checkCode.toLowerCase() || (ev.pieceCode && ev.pieceCode.toLowerCase() === checkCode.toLowerCase()))))
                    ));
                    if (collidesElsewhere) { errEl.textContent = `Code "${checkCode}" is already used by another item.`; return; }
                    seenCodes.add(checkCode.toLowerCase());
                }

                cleanVariants.push({
                    id: v.id, name: vName, code: vCode, price: vPrice,
                    wholesaleSellingPrice: parseFloat(v.wholesaleSellingPrice) || 0,
                    wholesalePrice: parseFloat(v.wholesalePrice) || 0,
                    minimumPrice: parseFloat(v.minimumPrice) || 0,
                    qty: vQty, dualUnit: vDualUnit, unitsPerBox: vUnitsPerBox,
                    pieceCode: vPieceCode, piecePrice: vPiecePrice,
                    pieceWholesalePrice: vPieceWholesalePrice, pieceQty: vPieceQty,
                });
            }

            product.variants = cleanVariants;
            product.qty = cleanVariants.reduce((sum, v) => sum + v.qty, 0);
            product.price = cleanVariants.length > 0 ? Math.min(...cleanVariants.map(v => v.price)) : 0;
            safeSetItem('pos_inventory', JSON.stringify(inventory));
            queuePush();
            closeVariantsModal();
            renderInventoryTable();
            showToast('Variants updated.');
        }

//@fn saveWebAuthnCredential
async function saveWebAuthnCredential(record) {
            const db = await openWebAuthnDb();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(WEBAUTHN_STORE, 'readwrite');
                tx.objectStore(WEBAUTHN_STORE).put(record);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

//@fn scheduleSyncSocketReconnect
function scheduleSyncSocketReconnect() {
            if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
            wsReconnectTimer = setTimeout(connectSyncSocket, wsReconnectDelay);
            wsReconnectDelay = Math.min(wsReconnectDelay * 1.6, 30000);
        }

//@fn scopedField
function scopedField(fieldName, localValue) {
            if (viewedBranchId === 'self') return localValue;
            if (viewedBranchId === 'all') {
                let combined = Array.isArray(localValue) ? localValue.slice() : [];
                const members = (branchesSummaryCache && branchesSummaryCache.branches) || [];
                members.forEach(b => {
                    if (b.isSelf) return;
                    const detail = branchDetailCache[b.id];
                    if (detail && Array.isArray(detail[fieldName])) combined = combined.concat(detail[fieldName]);
                });
                return combined;
            }
            const detail = branchDetailCache[viewedBranchId];
            return (detail && Array.isArray(detail[fieldName])) ? detail[fieldName] : [];
        }

//@fn scrollToTop
function scrollToTop() {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

//@fn searchOtherBranchesForCart
async function searchOtherBranchesForCart(query) {
            const resultsBox = document.getElementById('search-results');
            // If the search box has already moved on since this was
            // scheduled, these results are stale — drop them rather than
            // appending something that no longer matches what's on screen.
            if (document.getElementById('sales-search').value.trim().toLowerCase() !== query) return;

            // Shown immediately so a slow branch group never looks like the
            // feature just isn't there — the difference between "still
            // searching" and "genuinely no matches" was previously
            // impossible to tell apart, since both looked like nothing
            // happened at all.
            const loadingEl = document.createElement('div');
            loadingEl.id = 'cross-branch-search-loading';
            loadingEl.className = 'notif-dropdown-header';
            loadingEl.style.cssText = 'padding:6px 12px; font-size:11px;';
            loadingEl.textContent = '🔀 Searching other branches…';
            resultsBox.appendChild(loadingEl);

            try {
                const res = await fetch(apiUrl('/api/cross-branch-sale'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'searchOtherBranches', query }),
                });
                const data = await res.json();
                const stillCurrent = document.getElementById('sales-search').value.trim().toLowerCase() === query;
                const stillLoading = document.getElementById('cross-branch-search-loading');
                if (stillLoading) stillLoading.remove();
                if (!stillCurrent) return;

                if (!res.ok) {
                    return; // a failed lookup shouldn't disrupt the local results already showing
                }
                if (!data.results || data.results.length === 0) {
                    const noneEl = document.createElement('div');
                    noneEl.className = 'notif-dropdown-header';
                    noneEl.style.cssText = 'padding:6px 12px; font-size:11px; color:#95a5a6;';
                    noneEl.textContent = '🔀 No matches in other branches';
                    resultsBox.appendChild(noneEl);
                    return;
                }

                const rowsHtml = data.results.map(r => {
                    const boxOut = (r.qty || 0) <= 0;
                    const pieceOut = r.dualUnit && (r.pieceQty || 0) <= 0;
                    if (r.dualUnit) {
                        return `
                        <div class="search-item ${boxOut ? 'out-of-stock' : ''}" onclick="${boxOut ? '' : `addCrossBranchItemToCart('${escapeJsAttr(r.branchClientId)}', '${escapeJsAttr(r.branchLabel)}', '${escapeJsAttr(r.code)}', '${escapeJsAttr(r.name)}', ${r.price}, 'box')`}">
                            <span>${escapeHtml(r.name)} (Box) <span class="dual-unit-badge" style="background:#8e44ad;">🔀 ${escapeHtml(r.branchLabel)}</span></span>
                            <span>${boxOut ? 'Out of stock' : 'KES ' + (Number(r.price) || 0).toFixed(2) + ' / box'}</span>
                        </div>
                        <div class="search-item ${pieceOut ? 'out-of-stock' : ''}" onclick="${pieceOut ? '' : `addCrossBranchItemToCart('${escapeJsAttr(r.branchClientId)}', '${escapeJsAttr(r.branchLabel)}', '${escapeJsAttr(r.code)}', '${escapeJsAttr(r.name)}', ${r.piecePrice}, 'piece')`}">
                            <span>${escapeHtml(r.name)} (Piece) <span class="dual-unit-badge" style="background:#8e44ad;">🔀 ${escapeHtml(r.branchLabel)}</span></span>
                            <span>${pieceOut ? 'Out of stock' : 'KES ' + (Number(r.piecePrice) || 0).toFixed(2) + ' / piece'}</span>
                        </div>`;
                    }
                    return `<div class="search-item ${boxOut ? 'out-of-stock' : ''}" onclick="${boxOut ? '' : `addCrossBranchItemToCart('${escapeJsAttr(r.branchClientId)}', '${escapeJsAttr(r.branchLabel)}', '${escapeJsAttr(r.code)}', '${escapeJsAttr(r.name)}', ${r.price}, '')`}">
                        <span>${escapeHtml(r.name)} <span class="dual-unit-badge" style="background:#8e44ad;">🔀 ${escapeHtml(r.branchLabel)}</span></span>
                        <span>${boxOut ? 'Out of stock' : 'KES ' + (Number(r.price) || 0).toFixed(2)}</span>
                    </div>`;
                }).join('');

                resultsBox.innerHTML += `<div class="notif-dropdown-header" style="padding:6px 12px; font-size:11px;">From other branches</div>` + rowsHtml;
                resultsBox.style.display = 'block';
            } catch (e) {
                const stillLoading = document.getElementById('cross-branch-search-loading');
                if (stillLoading) stillLoading.remove();
                // A failed cross-branch lookup shouldn't disrupt the local
                // search results already showing — fail silently.
            }
        }

//@fn searchOtherBranchesForExchange
async function searchOtherBranchesForExchange() {
            const query = (document.getElementById('exchange-item-search').value || '').trim();
            if (!query) { showToast('Type an item name or code to search first.', true); return; }
            const resultsBox = document.getElementById('exchange-item-search-results');
            resultsBox.innerHTML = `<div class="search-item">🔀 Searching other branches…</div>`;
            resultsBox.style.display = 'block';
            try {
                const res = await fetch(apiUrl('/api/cross-branch-sale'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'searchOtherBranches', query: query.toLowerCase() }),
                });
                const data = await res.json();
                if (!res.ok || !data.results || data.results.length === 0) {
                    resultsBox.innerHTML = `<div class="search-item">No matches in other branches.</div>`;
                    return;
                }
                resultsBox.innerHTML = data.results.map(r => `
                    <div class="search-item" onclick="addCrossBranchExchangeItem('${escapeJsAttr(r.branchClientId)}', '${escapeJsAttr(r.branchLabel)}', '${escapeJsAttr(r.code)}', '${escapeJsAttr(r.name)}', ${r.price})">
                        <span>${escapeHtml(r.name)} <span class="dual-unit-badge" style="background:#8e44ad;">🔀 ${escapeHtml(r.branchLabel)}</span></span>
                        <span>KES ${(r.price || 0).toFixed(2)}</span>
                    </div>`).join('');
            } catch (e) {
                resultsBox.innerHTML = `<div class="search-item">${escapeHtml(netErrText('Couldn’t reach other branches'))}</div>`;
            }
        }

//@fn selectLoginAdmin
function selectLoginAdmin() {
            document.getElementById('login-picker-step').style.display = 'none';
            document.getElementById('login-staffpin-step').style.display = 'none';
            document.getElementById('login-adminpw-step').style.display = 'block';
            document.getElementById('login-error').textContent = '';
            const pwInput = document.getElementById('login-password-input');
            pwInput.value = '';
            setTimeout(() => pwInput.focus(), 50);
        }

//@fn selectLoginStaff
function selectLoginStaff(id) {
            const member = staff.find(s => s.id === id);
            if (!member) return;
            pendingLoginStaffId = id;
            document.getElementById('login-staffpin-name').innerText = member.name;
            document.getElementById('login-picker-step').style.display = 'none';
            document.getElementById('login-adminpw-step').style.display = 'none';
            document.getElementById('login-staffpin-step').style.display = 'block';
            document.getElementById('login-staffpin-error').textContent = '';
            const pinInput = document.getElementById('login-staffpin-input');
            pinInput.value = '';
            setTimeout(() => pinInput.focus(), 50);
        }

//@fn selectPastSaleItem
function selectPastSaleItem(code) {
            const product = inventory.find(p => p.code === code);
            if (!product) return;
            selectedPastSaleItem = product;
            document.getElementById('past-sale-item-search').value = '';
            document.getElementById('past-sale-item-results').style.display = 'none';
            document.getElementById('past-sale-selected-item').textContent = `Selected: ${product.name}`;
            // Retail/Wholesale/Custom, same choice as a live sale — defaults
            // to Retail (as before) but Wholesale is now one tap away
            // instead of needing the exact number typed in by hand.
            pastSalePriceTier = 'retail';
            const retailBtn = document.getElementById('past-sale-price-retail-btn');
            const wholesaleBtn = document.getElementById('past-sale-price-wholesale-btn');
            const customBtn = document.getElementById('past-sale-price-custom-btn');
            if (retailBtn) {
                retailBtn.textContent = `Retail — KES ${(product.price || 0).toFixed(2)}`;
                retailBtn.classList.add('active');
            }
            if (wholesaleBtn) {
                const hasWholesale = Number(product.wholesaleSellingPrice) > 0;
                wholesaleBtn.textContent = `Wholesale — KES ${(Number(product.wholesaleSellingPrice) || 0).toFixed(2)}`;
                wholesaleBtn.style.display = hasWholesale ? '' : 'none';
                wholesaleBtn.classList.remove('active');
            }
            if (customBtn) customBtn.classList.remove('active');
            document.getElementById('past-sale-price-input').value = (product.price || 0).toFixed(2);
            document.getElementById('past-sale-price-input').readOnly = false;
        }

//@fn choosePastSalePriceTier
// Same idea as the live Sales Counter's Retail/Wholesale/Custom picker
// (openPriceSelectModal), adapted for the flat Record-a-Past-Sale/Hire
// form: Retail/Wholesale fill the field with that tier's price; Custom
// just clears it and focuses it for a typed amount. The field stays a
// normal editable number input throughout, so a typed Retail/Wholesale
// figure can still be nudged afterwards (e.g. a small agreed discount).
function choosePastSalePriceTier(tier) {
            pastSalePriceTier = tier;
            const input = document.getElementById('past-sale-price-input');
            ['retail', 'wholesale', 'custom'].forEach(t => {
                const btn = document.getElementById(`past-sale-price-${t}-btn`);
                if (btn) btn.classList.toggle('active', t === tier);
            });
            if (tier === 'retail') {
                input.value = ((selectedPastSaleItem && selectedPastSaleItem.price) || 0).toFixed(2);
            } else if (tier === 'wholesale') {
                input.value = ((selectedPastSaleItem && Number(selectedPastSaleItem.wholesaleSellingPrice)) || 0).toFixed(2);
            } else {
                input.value = '';
                input.focus();
            }
        }

//@fn selectServerToLogin
function selectServerToLogin(id) {
            pendingServerLoginId = id;
            document.getElementById('server-pin-entry').style.display = 'block';
            document.getElementById('server-pin-error').textContent = '';
            document.getElementById('server-pin-input').value = '';
            document.getElementById('server-pin-input').focus();
        }

//@fn selectUnavailableItem
function selectUnavailableItem(code, name) {
            selectedUnavailableItem = { code, name };
            document.getElementById('exchange-unavailable-item-search').value = name;
            document.getElementById('exchange-unavailable-item-results').style.display = 'none';
            document.getElementById('exchange-unavailable-selected').textContent = `Waiting for: ${name}`;
        }

//@fn sendBillReminderSms
async function sendBillReminderSms(billId) {
            const bill = bills.find(b => b.id === billId);
            if (!bill) return;
            const phone = bill.customerPhone || bill.mpesaPhone;
            if (!phone) {
                showToast('No phone number on file for this bill.', true);
                return;
            }
            try {
                const statusRes = await fetch(apiUrl('/api/sms-config?status=1'));
                const status = await statusRes.json();
                if (!status.configured) {
                    showToast('SMS isn’t set up yet — add your Africa’s Talking account in ⚙️ Settings first.', true);
                    return;
                }
                const itemsTotal = (bill.items || []).reduce((sum, l) => sum + l.price * l.qty, 0);
                const owed = Math.max(0, itemsTotal - (bill.amountPaid || 0));
                const message = buildBillOwedMessage(bill.customerName, owed);
                const res = await fetch(apiUrl('/api/sms-send'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ to: phone, message }),
                });
                const data = await res.json();
                showToast(data.success ? `Reminder sent to ${phone}.` : (data.error || 'Could not send reminder.'), !data.success);
            } catch (e) {
                showToast(netErrText('Could not reach the server'), true);
            }
        }

//@fn sendToPoleDisplay
async function sendToPoleDisplay(line1, line2) {
            if (!poleDisplayWriter) return false;
            try {
                await poleDisplayWriter.write(buildPoleDisplayBytes(line1, line2));
                return true;
            } catch (e) {
                return false;
            }
        }

//@fn setAddItemMode
function setAddItemMode(mode) {
            addItemMode = mode;
            document.getElementById('add-item-mode-single-btn').classList.toggle('active', mode === 'single');
            document.getElementById('add-item-mode-bulk-btn').classList.toggle('active', mode === 'bulk');
            document.getElementById('single-add-item-panels').style.display = mode === 'single' ? 'grid' : 'none';
            document.getElementById('bulk-add-panel').style.display = mode === 'bulk' ? 'block' : 'none';
            if (mode === 'bulk' && bulkAddRows.length === 0) initBulkAddForm();
        }

//@fn setAllBroadcastRecipients
function setAllBroadcastRecipients(checked) {
            document.querySelectorAll('.broadcast-customer-checkbox').forEach(cb => { cb.checked = checked; });
        }

//@fn setAllFaultyItemsSelected
function setAllFaultyItemsSelected(checked) {
            document.querySelectorAll('.faulty-item-checkbox:not(:disabled)').forEach(cb => { cb.checked = checked; });
        }

//@fn setAutoThankYouEnabled
async function setAutoThankYouEnabled(checked) {
            try {
                await fetch(apiUrl('/api/sms-config'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ autoThankYouEnabled: checked }),
                });
            } catch (e) { /* setting still applies locally for this session even if the save failed */ }
        }

//@fn setBarcodeScanModalStatus
function setBarcodeScanModalStatus(text) {
            const el = document.getElementById('barcode-scan-status');
            if (el) el.textContent = text;
        }

//@fn setBillFulfillmentType
function setBillFulfillmentType(type) {
            billFulfillmentType = type === 'held_in_shop' ? 'held_in_shop' : 'carried_immediately';
            document.getElementById('bill-fulfillment-carried-btn').classList.toggle('active', billFulfillmentType === 'carried_immediately');
            document.getElementById('bill-fulfillment-held-btn').classList.toggle('active', billFulfillmentType === 'held_in_shop');
            document.getElementById('bill-fulfillment-hint').textContent = billFulfillmentType === 'held_in_shop'
                ? 'Stock stays in inventory — nothing is deducted until the item is released from the 🧾 Bills tab (or the bill is fully paid and you confirm pickup).'
                : 'Stock is deducted now, same as any other sale — the customer is walking out with it on credit.';
        }

//@fn setBillUpfrontMethod
function setBillUpfrontMethod(method) {
            const valid = ['cash', 'mpesa', 'bank', 'card', 'split'];
            billUpfrontMethod = valid.includes(method) ? method : 'cash';
            document.getElementById('bill-upfront-cash-btn').classList.toggle('active', billUpfrontMethod === 'cash');
            document.getElementById('bill-upfront-mpesa-btn').classList.toggle('active', billUpfrontMethod === 'mpesa');
            document.getElementById('bill-upfront-bank-btn').classList.toggle('active', billUpfrontMethod === 'bank');
            document.getElementById('bill-upfront-card-btn').classList.toggle('active', billUpfrontMethod === 'card');
            const splitBtn = document.getElementById('bill-upfront-split-btn');
            if (splitBtn) splitBtn.classList.toggle('active', billUpfrontMethod === 'split');
            document.getElementById('bill-upfront-mpesa-code-input').style.display = billUpfrontMethod === 'mpesa' ? 'block' : 'none';
            document.getElementById('bill-upfront-bank-ref-input').style.display = billUpfrontMethod === 'bank' ? 'block' : 'none';
            const splitInputs = document.getElementById('bill-upfront-split-inputs');
            if (splitInputs) splitInputs.style.display = billUpfrontMethod === 'split' ? 'block' : 'none';
        }

//@fn setCameraScanStatus
function setCameraScanStatus(text) {
            const el = document.getElementById('camera-scan-status');
            if (el) el.textContent = text;
        }

//@fn setComboRowMode
function setComboRowMode(idx, mode) {
            comboDraft[idx].mode = mode === 'custom' ? 'custom' : 'existing';
            renderComboRows();
        }

//@fn setContractType
function setContractType(type) {
            activeContractType = type === 'wholesale' ? 'wholesale' : 'retail';
            document.getElementById('contract-type-retail-btn').classList.toggle('active', activeContractType === 'retail');
            document.getElementById('contract-type-wholesale-btn').classList.toggle('active', activeContractType === 'wholesale');
            document.getElementById('contract-price-col-label').textContent = activeContractType === 'wholesale' ? 'Price Given At' : 'Shop Price (auto)';
            renderContractRows();
        }

//@fn setCustomerStatementPeriod
function setCustomerStatementPeriod(preset) {
            currentCustomerStatementPeriod = preset;
            document.querySelectorAll('#customer-statement-period-filter-bar .item-filter-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.period === preset);
            });
            renderCustomerProfileBody();
        }

//@fn setDailySalesMethodFilter
function setDailySalesMethodFilter(method) {
            dailySalesMethodFilter = method;
            document.querySelectorAll('#daily-sales-method-filter-bar .item-filter-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.method === method);
            });
            renderDailySales();
        }

//@fn setDeliveryPaymentCaptureMethod
function setDeliveryPaymentCaptureMethod(method) {
            deliveryPaymentCaptureMethod = ['cash', 'mpesa', 'split'].includes(method) ? method : 'cash';
            const methods = ['cash', 'mpesa', 'split'];
            document.querySelectorAll('#delivery-payment-method-toggle .type-toggle-btn').forEach((btn, idx) => {
                btn.classList.toggle('active', methods[idx] === deliveryPaymentCaptureMethod);
            });
            document.getElementById('delivery-payment-mpesa-code-group').style.display = deliveryPaymentCaptureMethod === 'mpesa' ? 'block' : 'none';
            document.getElementById('delivery-payment-split-group').style.display = deliveryPaymentCaptureMethod === 'split' ? 'flex' : 'none';
        }

//@fn setDeviceName
function setDeviceName(name) {
            thisDeviceName = (name || '').trim().slice(0, 40) || defaultDeviceName();
            safeSetItem('pos_device_name', thisDeviceName);
            heartbeatDeviceNetwork();
        }

//@fn setDeviceStation
function setDeviceStation(station) {
            thisDeviceStation = PRINTER_NETWORK_STATIONS.includes(station) ? station : 'Other';
            safeSetItem('pos_device_station', thisDeviceStation);
            heartbeatDeviceNetwork();
        }

//@fn setDoGasRefills
function setDoGasRefills(checked) {
            doGasRefills = checked;
            safeSetItem('pos_do_gas_refills', String(checked));
            updateGasTabVisibility();
            queuePush();
        }

//@fn setEtimsLogPeriod
function setEtimsLogPeriod(preset) {
            document.querySelectorAll('#etims-log-period-filter-bar .item-filter-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.period === preset);
            });
            const showEl = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none'; };
            showEl('etims-log-period-daily-group', preset === 'daily');
            showEl('etims-log-period-monthly-group', preset === 'monthly');
            showEl('etims-log-period-custom-from-group', preset === 'custom');
            showEl('etims-log-period-custom-to-group', preset === 'custom');
            renderEtimsLog();
        }

//@fn setExchangeTopupMethod
function setExchangeTopupMethod(method) {
            exchangeTopupMethod = method;
            document.getElementById('exchange-topup-cash-btn').classList.toggle('active', method === 'cash');
            document.getElementById('exchange-topup-mpesa-btn').classList.toggle('active', method === 'mpesa');
            document.getElementById('exchange-topup-split-btn').classList.toggle('active', method === 'split');
            document.getElementById('exchange-topup-split-inputs').style.display = method === 'split' ? 'flex' : 'none';
            if (method === 'split') syncExchangeSplitDefaults(getExchangeNetPayable());
        }

//@fn setFieldAndFireInput
function setFieldAndFireInput(id, value) {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }

//@fn setGasTxType
function setGasTxType(type) {
            gasTxType = type;
            ['exchange', 'outright', 'set', 'empty'].forEach(t => {
                const btn = document.getElementById(`gas-tx-${t}-btn`);
                if (btn) btn.classList.toggle('active', t === type);
            });
            const accessoriesPanel = document.getElementById('gas-set-accessories');
            if (accessoriesPanel) accessoriesPanel.style.display = type === 'set' ? 'block' : 'none';
            renderGasVariantStock();
        }

//@fn setImageSource
function setImageSource(mode) {
            // Zip 132: adding an item uploads a photo from the device only; the camera is never opened here.
            imageSourceMode = 'upload';
            const up = document.getElementById('upload-wrapper');
            if (up) up.classList.add('show');
            stopCamera();
        }

//@fn setLocStatus
function setLocStatus(kind, label, status) {
            const map = kind === 'table' ? tableStates : roomStates;
            if (!map[label]) map[label] = { status: 'available', reservation: null };
            map[label].status = status;
            // Leaving "reserved" clears whatever booking details were on file —
            // otherwise the next guest to reserve that table would see the last
            // group's name and phone number still sitting in the fields.
            if (status !== 'reserved') map[label].reservation = null;
            safeSetItem(kind === 'table' ? 'pos_table_states' : 'pos_room_states', JSON.stringify(map));
            queuePush();
            renderTablesRoomsLists();
            renderSalesLocationSelect();
        }

//@fn setOfferType
function setOfferType(type) {
            offerType = type === 'fixed' ? 'fixed' : 'percent';
            const toggle = document.getElementById('offer-type-toggle');
            toggle.querySelectorAll('button').forEach((btn, idx) => {
                btn.classList.toggle('active', (idx === 0 && offerType === 'percent') || (idx === 1 && offerType === 'fixed'));
            });
            document.getElementById('offer-value-label').textContent = offerType === 'fixed' ? 'New Price (KES)' : 'Discount Percentage (%)';
        }

//@fn setOrderType
function setOrderType(type) {
            orderType = type === 'delivery' ? 'delivery' : 'walkin';
            document.getElementById('order-walkin-btn').classList.toggle('active', orderType === 'walkin');
            document.getElementById('order-delivery-btn').classList.toggle('active', orderType === 'delivery');
            document.getElementById('delivery-details-group').style.display = orderType === 'delivery' ? 'block' : 'none';
            if (orderType !== 'delivery') {
                const freeToggle = document.getElementById('free-delivery-toggle');
                if (freeToggle && freeToggle.checked) setFreeDeliveryApplied(false);
                if (freeToggle) freeToggle.checked = false;
                // Walk-in sales are always paid at the till — "Pay on
                // Delivery" only makes sense for a delivery. Without this,
                // switching back to Walk-in after having picked Delivery +
                // Pay-on-Delivery left deliveryPaymentMode stuck at 'pod',
                // which hides the whole Payment Method toggle (see
                // setDeliveryPaymentMode() below) for this and every sale
                // after it — invisible until the person happened to revisit
                // Delivery and pick "Paid Now" again to clear it.
                setDeliveryPaymentMode('now');
            }
            if (orderType === 'delivery') {
                renderDeliveryZoneSelect();
                renderDeliveryAgentSelect();
                setDeliveryPaymentMode('now');
            }
        }

//@fn setPaymentAccountBranch
async function setPaymentAccountBranch(accountId, branchClientId) {
            const account = paymentAccounts.find(a => a.id === accountId);
            if (!account) return;
            try {
                const res = await fetch(apiUrl('/api/payment-accounts'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'setBranch', accountId, branchClientId: branchClientId || '' }),
                });
                const data = await res.json();
                if (!res.ok || data.error) { showToast(data.error || 'Could not update that connection.', true); renderPaymentAccountsListView(); return; }
                paymentAccounts = data.accounts;
                showToast(branchClientId ? `"${account.name}" connected to that branch.` : `"${account.name}" disconnected from any branch.`);
            } catch (e) {
                showToast(netErrText('Could not reach the server'), true);
            }
        }

//@fn setPoleDisplayMode
function setPoleDisplayMode(mode) {
            poleDisplayMode = mode === 'cd5220' ? 'cd5220' : 'epson';
            safeSetItem('pos_pole_display_mode', poleDisplayMode);
        }

//@fn setProfitPeriod
function setProfitPeriod(preset) {
            document.querySelectorAll('#profit-period-filter-bar .item-filter-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.period === preset);
            });
            const showEl = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none'; };
            showEl('profit-period-daily-group', preset === 'daily');
            showEl('profit-period-monthly-group', preset === 'monthly');
            showEl('profit-period-custom-from-group', preset === 'custom');
            showEl('profit-period-custom-to-group', preset === 'custom');
            renderProfitReport();
        }

//@fn setPromoOfferScope
function setPromoOfferScope(scope) {
            document.querySelectorAll('#offer-scope-toggle .type-toggle-btn').forEach(btn => btn.classList.remove('active'));
            const idx = scope === 'all' ? 0 : 1;
            document.querySelectorAll('#offer-scope-toggle .type-toggle-btn')[idx].classList.add('active');
            document.getElementById('offer-target-picker').style.display = scope === 'all' ? 'none' : 'block';
            document.getElementById('offer-target-picker').dataset.scope = scope;
        }

//@fn setQtyDisplayFormat
function setQtyDisplayFormat(mode) {
            qtyDisplayFormat = mode === 'fraction' ? 'fraction' : 'decimal';
            safeSetItem('pos_qty_display_format', qtyDisplayFormat);
            document.getElementById('qty-format-decimal-btn').classList.toggle('active', qtyDisplayFormat === 'decimal');
            document.getElementById('qty-format-fraction-btn').classList.toggle('active', qtyDisplayFormat === 'fraction');
            renderAllViews();
        }

//@fn setReceiptCopies
function setReceiptCopies(value) {
            const n = Math.min(5, Math.max(1, parseInt(value, 10) || 1));
            receiptCopies = n;
            safeSetItem('pos_receipt_copies', String(n));
            document.getElementById('receipt-copies-input').value = n;
        }

//@fn setReturnMode
function setReturnMode(mode) {
            returnMode = mode;
            document.getElementById('return-mode-simple-btn').classList.toggle('active', mode === 'simple');
            document.getElementById('return-mode-exchange-btn').classList.toggle('active', mode === 'exchange');
            document.getElementById('return-topup-section').style.display = mode === 'simple' ? 'block' : 'none';
            document.getElementById('exchange-section').style.display = mode === 'exchange' ? 'block' : 'none';
            document.getElementById('return-save-btn').innerText = mode === 'exchange' ? '🔁 Complete Exchange' : '💾 Record Return';
            const hintEl = document.getElementById('return-mode-hint');
            if (hintEl) hintEl.textContent = mode === 'simple'
                ? 'Only use this when there is truly no suitable replacement in stock — the item is taken back, with no cash paid out either way.'
                : '';
            if (mode === 'exchange') { autofillExchangeCreditValue(); renderExchangeBalance(); }
            updateSameItemButton();
        }

//@fn setSalesTablePeriod
function setSalesTablePeriod(preset) {
            document.querySelectorAll('#sales-table-period-filter-bar .item-filter-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.period === preset);
            });
            const showEl = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none'; };
            showEl('sales-table-period-daily-group', preset === 'daily');
            showEl('sales-table-period-monthly-group', preset === 'monthly');
            showEl('sales-table-period-custom-from-group', preset === 'custom');
            showEl('sales-table-period-custom-to-group', preset === 'custom');
            renderDailySales();
        }

//@fn setShowItemImageGrid
function setShowItemImageGrid(checked) {
            showItemImageGrid = checked;
            safeSetItem('pos_show_item_grid', checked ? 'true' : 'false');
            renderItemImageGrid(document.getElementById('sales-search') ? document.getElementById('sales-search').value : '');
        }

//@fn setSmsProvider
function setSmsProvider(provider) {
            const valid = ['africastalking', 'mobitech', 'celcom', 'advanta', 'talksasa'];
            smsProviderChoice = valid.includes(provider) ? provider : 'africastalking';
            const idsByProvider = {
                africastalking: ['sms-provider-at-btn', 'sms-provider-at-fields'],
                mobitech: ['sms-provider-mobitech-btn', 'sms-provider-mobitech-fields'],
                celcom: ['sms-provider-celcom-btn', 'sms-provider-celcom-fields'],
                advanta: ['sms-provider-advanta-btn', 'sms-provider-advanta-fields'],
                talksasa: ['sms-provider-talksasa-btn', 'sms-provider-talksasa-fields'],
            };
            valid.forEach((p) => {
                const [btnId, fieldsId] = idsByProvider[p];
                const btn = document.getElementById(btnId);
                const fields = document.getElementById(fieldsId);
                if (btn) btn.classList.toggle('active', smsProviderChoice === p);
                if (fields) fields.style.display = smsProviderChoice === p ? 'block' : 'none';
            });
        }

//@fn setStockReportPeriod
function setStockReportPeriod(preset) {
            document.querySelectorAll('#stock-report-period-filter-bar .item-filter-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.period === preset);
            });
            const showEl = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none'; };
            showEl('stock-report-period-daily-group', preset === 'daily');
            showEl('stock-report-period-monthly-group', preset === 'monthly');
            showEl('stock-report-period-custom-from-group', preset === 'custom');
            showEl('stock-report-period-custom-to-group', preset === 'custom');
            renderStockReport();
        }

//@fn setTabReadOnly
function setTabReadOnly(tabContentId, readOnly) {
            const tab = document.getElementById(tabContentId);
            if (!tab) return;
            tab.querySelectorAll('button, input, select, textarea').forEach(el => {
                if (el.closest('.branch-scope-bar')) return;
                if (el.closest('.item-filter-bar') || el.closest('.report-range-bar')) return;
                const onclickAttr = el.getAttribute('onclick') || '';
                if (/print/i.test(onclickAttr) || /Period/.test(onclickAttr)) return;
                if (readOnly) {
                    if (!el.hasAttribute('data-branch-scope-was-disabled')) {
                        el.setAttribute('data-branch-scope-was-disabled', el.disabled ? '1' : '0');
                    }
                    el.disabled = true;
                } else if (el.hasAttribute('data-branch-scope-was-disabled')) {
                    el.disabled = el.getAttribute('data-branch-scope-was-disabled') === '1';
                    el.removeAttribute('data-branch-scope-was-disabled');
                }
            });
            let banner = tab.querySelector('.branch-scope-banner');
            if (readOnly) {
                const label = viewedBranchId === 'all'
                    ? 'All Branches (Combined)'
                    : (((branchesSummaryCache && branchesSummaryCache.branches) || []).find(b => b.id === viewedBranchId) || {}).label || 'another branch';
                if (banner) { banner.style.display = 'block'; banner.textContent = `👁️ Viewing ${label} — read-only. Switch back to "This Branch" to make changes here.`; }
            } else if (banner) {
                banner.style.display = 'none';
            }
        }

//@fn setTradeCreditDirection
function setTradeCreditDirection(direction) {
            tradeCreditDirectionDraft = direction === 'they_owe' ? 'they_owe' : 'i_owe';
            document.querySelectorAll('#tc-manual-direction-toggle .type-toggle-btn').forEach((btn, i) => {
                btn.classList.toggle('active', (i === 0 && tradeCreditDirectionDraft === 'i_owe') || (i === 1 && tradeCreditDirectionDraft === 'they_owe'));
            });
        }

//@fn settleTradeCredit
function settleTradeCredit(id) {
            const entry = tradeCredits.find(t => t.id === id);
            if (!entry) return;
            const verb = entry.direction === 'i_owe' ? 'paid' : 'received';
            if (!confirm(`Mark KES ${entry.amount.toFixed(2)} to ${entry.partyName} as settled (${verb})?`)) return;
            entry.status = 'settled';
            entry.settledAt = new Date().toISOString();
            safeSetItem('pos_trade_credits', JSON.stringify(tradeCredits));
            queuePush();
            renderTradeCreditsTab();
            showToast('Marked as settled.');
        }

//@fn setupPoleDisplayConnectListener
function setupPoleDisplayConnectListener() {
            if (!navigator.serial || poleDisplayConnectListenerAdded) return;
            poleDisplayConnectListenerAdded = true;
            navigator.serial.addEventListener('connect', async (event) => {
                if (poleDisplayPort) return; // already connected to something
                try {
                    await openPoleDisplayPort(event.target);
                    const statusEl = document.getElementById('pole-display-status');
                    if (statusEl) { statusEl.className = 'settings-msg success'; statusEl.textContent = 'Connected automatically.'; }
                } catch (e) {
                    // Left disconnected — Settings' Connect button still works.
                }
            });
        }

//@fn showAuthStep
function showAuthStep(step) {
            document.getElementById('auth-checking-box').style.display = 'none';
            document.getElementById('auth-choice-box').style.display = step === 'choice' ? 'block' : 'none';
            document.getElementById('auth-signup-box').style.display = step === 'signup' ? 'block' : 'none';
        }

//@fn showCustomerDisplayDetectBanner
function showCustomerDisplayDetectBanner() {
            if (document.getElementById('cd-detect-banner')) return;
            const lastDismissed = parseInt(localStorage.getItem('pos_cd_detect_last') || '0', 10);
            if (Date.now() - lastDismissed < 3 * 24 * 60 * 60 * 1000) return;
            safeSetItem('pos_cd_detect_last', String(Date.now()));
            const banner = document.createElement('div');
            banner.id = 'cd-detect-banner';
            banner.style.cssText = 'position:fixed; left:12px; right:12px; bottom:12px; z-index:99999; background:#fff; border:1px solid var(--light); border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,0.18); padding:14px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; max-width:480px; margin:0 auto;';
            banner.innerHTML = `
                <span style="flex:1; min-width:200px; font-size:14px;">🖥️ A second screen is connected — use it as a customer-facing display?</span>
                <button type="button" class="btn-main settings-small-btn" onclick="dismissCustomerDisplayDetectBanner(true)">Use it</button>
                <button type="button" class="settings-small-btn" onclick="dismissCustomerDisplayDetectBanner(false)">Not now</button>
            `;
            document.body.appendChild(banner);
        }

//@fn showLoginPickerStep
function showLoginPickerStep() {
            pendingLoginStaffId = null;
            renderLoginPicker();
            document.getElementById('login-picker-step').style.display = 'block';
            document.getElementById('login-staffpin-step').style.display = 'none';
            document.getElementById('login-adminpw-step').style.display = 'none';
            document.getElementById('login-recovery-step').style.display = 'none';
            document.getElementById('login-staffpin-error').textContent = '';
            document.getElementById('login-error').textContent = '';
        }

//@fn showNotificationPromptBanner
function showNotificationPromptBanner() {
            if (document.getElementById('notif-prompt-banner')) return;
            safeSetItem('pos_notif_prompt_last', String(Date.now()));
            const banner = document.createElement('div');
            banner.id = 'notif-prompt-banner';
            banner.style.cssText = 'position:fixed; left:12px; right:12px; bottom:12px; z-index:99999; background:#fff; border:1px solid var(--light); border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,0.18); padding:14px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; max-width:480px; margin:0 auto;';
            banner.innerHTML = `
                <span style="flex:1; min-width:200px; font-size:14px;">🔔 Turn on notifications for low-stock and expiry alerts?</span>
                <button type="button" class="btn-main settings-small-btn" onclick="dismissNotificationPromptBanner(true)">Enable</button>
                <button type="button" class="settings-small-btn" onclick="dismissNotificationPromptBanner(false)">Not now</button>
            `;
            document.body.appendChild(banner);
        }

//@fn showRecoverySignInStep
function showRecoverySignInStep() {
            document.getElementById('login-adminpw-step').style.display = 'none';
            document.getElementById('login-recovery-step').style.display = 'block';
            document.getElementById('login-recovery-error').textContent = '';
            document.getElementById('recovery-signin-password').value = '';
        }

//@fn showUpgradeScreen
function showUpgradeScreen() {
            const lockScreen = document.getElementById('license-lock-screen');
            if (!lockScreen) return;
            upgradeScreenManuallyOpen = true;
            lockScreen.style.display = 'flex';
            const titleEl = document.getElementById('license-lock-title');
            if (titleEl) titleEl.textContent = '⭐ Upgrade to a Permanent Link';
            const reasonEl = document.getElementById('license-lock-reason');
            if (reasonEl) {
                reasonEl.textContent = licenseInfo.paymentClaimed
                    ? 'We’ve got your payment claim — waiting for it to be confirmed.'
                    : `Your trial still has ${formatRemaining(licenseInfo.remainingMs || 0)} left. Upgrade any time to keep this link working after that.`;
            }
            const claimBtn = document.getElementById('license-claim-payment-btn');
            if (claimBtn) claimBtn.style.display = licenseInfo.paymentClaimed ? 'none' : 'block';
            const closeBtn = document.getElementById('license-upgrade-close-btn');
            if (closeBtn) closeBtn.style.display = 'block';
        }

//@fn slugifyServiceName
function slugifyServiceName(name) {
            const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            return 'svc-' + (base || 'service');
        }

//@fn snapCaptureListPhoto
function snapCaptureListPhoto() {
            if (!captureListStream) return;
            const video = document.getElementById('capture-list-video');
            const canvas = document.getElementById('capture-list-canvas');
            canvas.width = video.videoWidth || 1024;
            canvas.height = video.videoHeight || 1024;
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            stopCaptureListCamera();
            runAiCaptureOnImage(dataUrl);
        }

//@fn snapPhoto
function snapPhoto() {
            const video = document.getElementById('video');
            const canvas = document.getElementById('canvas');
            if (!videoStream) {
                showToast('Camera is not active.', true);
                return;
            }
            const ctx = canvas.getContext('2d');
            // Un-mirror the capture since the preview video is flipped for a natural mirror view
            ctx.save();
            ctx.translate(canvas.width, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            ctx.restore();
            currentCapturedImageBase64 = canvasToSmallJpeg(canvas);
            document.getElementById('photo-preview-element').src = currentCapturedImageBase64;
            showToast('Photo captured.');
        }

//@fn pushKeyOf
function pushKeyOf(r) {
            return (r && typeof r === 'object')
                ? (r.id != null ? 'i:' + r.id : r.code != null ? 'c:' + r.code : r.token != null ? 't:' + r.token : null)
                : null;
        }

//@fn pushSigOf
function pushSigOf(r) {
            const j = JSON.stringify(r);
            let h = 0x811c9dc5;
            for (let i = 0; i < j.length; i++) { h ^= j.charCodeAt(i); h = Math.imul(h, 0x01000193); }
            return (h >>> 0) + ':' + j.length;
        }

//@fn ackServerRecords
function ackServerRecords(field, records) {
            // Records that CAME FROM the server (a pull, or older history fetched on demand) are already there: mark them
            // acknowledged so the next push doesn't send them back. Only matters once this session has pushed at least once
            // (before that, everything is sent anyway).
            try { if (typeof window.salesJournalSeenRecords === 'function') window.salesJournalSeenRecords(field, records); } catch (e) { /* housekeeping */ }
            try {
                // zip 129: also before this session's first push — the server HAS these, so they are never uploaded again
                window.__pushAck = window.__pushAck || {};
                const ack = window.__pushAck[field] || (window.__pushAck[field] = new Map());
                records.forEach((r) => { const k = pushKeyOf(r); if (k != null) ack.set(k, pushSigOf(r)); });
            } catch (e) { /* housekeeping only */ }
        }

//@fn hydrateOlderHistory
async function hydrateOlderHistory(hotFrom) {
            // A database shop sends devices only a recent window of the big logs. So a NEW device — or one that never saw the
            // older history — quietly fetches it, page by page, from /api/history, and merges it into its own lists, so reports over
            // older dates work here too. Rules that keep it harmless:
            //  * once per install (pos_hydrated_v1), starting a few seconds after a pull, never blocking anything;
            //  * only the last `pos_hydrate_days` (default 180);
            //  * stops as soon as this device is more than half full — it must never be the thing that fills a device;
            //  * only ever ADDS records this device doesn't have; anything it can't fetch is simply tried again next session.
            const FIELDS = ['salesLog', 'stockMovementLog', 'returns', 'expenses', 'tradeCredits', 'attendanceLog', 'adminActivityLog', 'dispatchLog'];
            try {
                if (window.__hydrating || !hotFrom) return false;
                if (localStorage.getItem('pos_hydrated_v1') === '1' || localStorage.getItem('aqua_hydrated_v1') === '1') return false;
                const keys = window.__LOG_KEYS || {};
                const arrays = {
                    salesLog: typeof salesLog === 'undefined' ? null : salesLog,
                    stockMovementLog: typeof stockMovementLog === 'undefined' ? null : stockMovementLog,
                    returns: typeof returns === 'undefined' ? null : returns,
                    expenses: typeof expenses === 'undefined' ? null : expenses,
                    tradeCredits: typeof tradeCredits === 'undefined' ? null : tradeCredits,
                    attendanceLog: typeof attendanceLog === 'undefined' ? null : attendanceLog,
                    adminActivityLog: typeof adminActivityLog === 'undefined' ? null : adminActivityLog,
                    dispatchLog: typeof dispatchLog === 'undefined' ? null : dispatchLog,
                };
                window.__hydrating = true;
                const days = Number(localStorage.getItem('pos_hydrate_days')) || 180;
                const from = Date.now() - days * 86400000;
                const QUOTA = 5000000;
                const used = () => (typeof window.__storageUsedChars === 'function' ? window.__storageUsedChars() : 0);
                const timeOf = (r) => { for (const f of ['timestamp', 'date', 'createdAt', 'clockIn', 'at']) { if (r && r[f] != null) { const t = typeof r[f] === 'number' ? r[f] : Date.parse(r[f]); if (isFinite(t)) return t; } } return NaN; };
                let complete = true;
                for (const f of FIELDS) {
                    const arr = arrays[f];
                    if (!Array.isArray(arr) || !keys[f]) continue;
                    const have = new Set();
                    arr.forEach((r) => { const k = pushKeyOf(r); if (k != null) have.add(k); });
                    const added = [];
                    let after = '';
                    for (let page = 0; page < 300; page++) {
                        if (used() > QUOTA * 0.5) break;
                        const path = `/api/history?col=${f}&from=${from}&to=${hotFrom}&limit=1000` + (after ? '&after=' + encodeURIComponent(after) : '');
                        const res = await fetch(apiUrl(path));
                        if (!res.ok) { complete = false; break; }
                        const out = await res.json();
                        (out.records || []).forEach((r) => { const k = pushKeyOf(r); if (k != null && !have.has(k)) { have.add(k); added.push(r); } });
                        if (!out.next) break;
                        after = out.next;
                        await new Promise((r) => setTimeout(r, 40));            // yield: never hog the till
                    }
                    if (added.length) {
                        const merged = arr.concat(added);
                        const dated = merged.filter((r) => isFinite(timeOf(r))).sort((a, b) => timeOf(a) - timeOf(b));
                        const rest = merged.filter((r) => !isFinite(timeOf(r)));
                        const all = dated.concat(rest);
                        arr.length = 0;
                        for (let i = 0; i < all.length; i++) arr.push(all[i]);
                        ackServerRecords(f, added);
                        safeSetItem(keys[f], JSON.stringify(arr));
                    }
                }
                if (complete) { try { localStorage.setItem('pos_hydrated_v1', '1'); } catch (e) { /* retry next session */ } }
                window.__hydrating = false;
                return true;
            } catch (e) {
                window.__hydrating = false;
                return false;
            }
        }

//@fn slimPayloadForPush
function slimPayloadForPush(payload) {
            // Every push used to upload the WHOLE sales / stock-movement history — 1.7 KB per sale — so a shop with a year of
            // history sent megabytes on every single sale. The server already merges these logs record-by-record (union by id;
            // see MERGE_BY_ID_FIELDS in functions/api/pos-sync.js), so it only needs the records that are NEW or CHANGED
            // (a void, a settlement) since the last push it acknowledged. Records the server already has are left out.
            //  * The first push after the app opens still sends everything (nothing has been acknowledged yet) — a safe reset
            //    point, and identical to the old behaviour.
            //  * If any record in a log has no id, that whole log is sent as before (the server can't match it).
            //  * Nothing is marked as acknowledged until the server says OK (call commit() then); a failed push resends.
            const LOG_FIELDS = ['salesLog', 'stockMovementLog', 'returns', 'expenses', 'tradeCredits', 'attendanceLog', 'adminActivityLog', 'dispatchLog'];
            stampLocalContext(payload);
            window.__pushAck = window.__pushAck || {};
            const body = { ...payload };
            const pending = {};
            const keyOf = pushKeyOf, sigOf = pushSigOf;
            // zip 129: a push used to carry the WHOLE history the first time after the app opened (nothing acknowledged yet). On a slow
            // line that upload timed out, was retried in full, and never finished — "retrying… sending…" for ever, no sale reaching the
            // server. Now a record is left out when the server already has it in the same version — seen in a pull, confirmed by
            // /api/sync-have (syncHaveCheck), or marked "on the server" by the sales journal — and what is left goes in BATCHES (newest
            // first), the next batch straight after the last one is accepted.
            let more = false;
            const scale = window.__pushBatchScale || 1;
            const CAP = { salesLog: 150, stockMovementLog: 400, returns: 150, expenses: 150, tradeCredits: 150, attendanceLog: 300, adminActivityLog: 300, dispatchLog: 150 };
            const known = typeof window.salesJournalKnownOnServer === 'function' ? window.salesJournalKnownOnServer : null;
            LOG_FIELDS.forEach((field) => {
                const arr = payload[field];
                if (!Array.isArray(arr) || arr.length === 0) return;
                const ack = window.__pushAck[field] || (window.__pushAck[field] = new Map());
                const changed = [];
                for (let i = 0; i < arr.length; i++) {
                    const r = arr[i];
                    const k = keyOf(r);
                    if (k == null) return;                    // unmatched records: leave this log whole (the server can't match them)
                    const sg = sigOf(r);
                    if (ack.get(k) === sg) continue;
                    if (known && known(field, r)) { ack.set(k, sg); continue; }
                    changed.push(r);
                }
                const cap = Math.max(10, Math.floor((CAP[field] || 200) * scale));
                const send = changed.length > cap ? changed.slice(changed.length - cap) : changed;
                if (send.length < changed.length) more = true;
                pending[field] = new Map(send.map((r) => [keyOf(r), sigOf(r)]));
                body[field] = send;
            });
            // What this push carries of each log, by version (zip 127): once the server answers OK, the sales journal marks exactly these
            // versions "on the server" — a record changed while the push was on its way stays waiting for the next one.
            const sentVersions = {};
            if (typeof window.salesJournalSig === 'function') {
                ['salesLog', 'stockMovementLog', 'returns', 'expenses'].forEach((f) => {
                    if (Array.isArray(body[f])) sentVersions[f] = body[f].filter((r) => r && r.id != null && !r._deleted).map((r) => [String(r.id), window.salesJournalSig(r)]);
                });
            }
            // WHOLE-VALUE SETTINGS (receipt text, VAT rates, tab locks, loyalty tiers, tables ...): stamp the ones THIS device changed since
            // it last agreed with the server, so the server can tell a real change from a stale copy (see mergeIncomingState in
            // functions/api/_merge.js). Before this device has agreed with the server once, nothing is stamped (old behaviour).
            const MERGED = new Set(['staff', 'pendingInvites', 'inventory', 'products', 'customers', 'suppliers', 'deliveryZones', 'deliveryAgents', 'offers',
                'bills', 'debts', 'recurringExpenses', 'contracts', 'staffShifts', 'attendanceRoster', 'sites', 'tanks', 'stockRequests',
                'salesLog', 'stockMovementLog', 'returns', 'expenses', 'tradeCredits', 'crossBranchSalesFacilitated', 'savedBarcodes', 'attendanceLog',
                'adminActivityLog', 'billNotifications', 'pendingExchanges', 'dispatchLog', 'purchaseOrders', 'patientCharges', 'tabs', 'cashShifts', 'approvalRequests', 'radiologyOrders', 'theatreCases', 'institutions', 'institutionCharges', 'resources', 'resourceSessions', 'facilityBookings', 'serviceRequests', 'customOrders', 'kegs',
                'patients', 'visits', 'labResults', 'admissions', 'appointments', 'queue', 'patientNotes', 'rawMaterials']);
            // DELETIONS. The server merges by union, so "missing from the push" means nothing. A record that was in one of these lists when this
            // device last agreed with the server and is gone now was DELETED here (a bill settled and removed, a supplier, an item...): send an
            // explicit tombstone so it stays deleted on every device and a stale copy can't bring it back.
            const TRACKED = ['inventory', 'products', 'customers', 'suppliers', 'deliveryZones', 'deliveryAgents', 'offers', 'bills', 'debts', 'recurringExpenses', 'contracts', 'pendingInvites', 'patients', 'patientNotes', 'labResults', 'appointments', 'queue', 'institutions', 'rawMaterials'];
            if (!window.__keyAck) window.__keyAck = loadKeyAck();
            const keysNow = {}, gone = {};
            TRACKED.forEach((col) => {
                const arr = payload[col];
                if (!Array.isArray(arr)) return;
                const cur = new Set();
                arr.forEach((r) => { const k = pushKeyOf(r); if (k != null) cur.add(k); });
                keysNow[col] = cur;
                const ackSet = window.__keyAck[col];
                if (!ackSet) return;
                const missing = [];
                ackSet.forEach((k) => { if (!cur.has(k)) missing.push(k); });
                if (missing.length === 0) return;
                // Safety net: if most of a list vanished at once it was replaced (a reset, a bad load), not edited — never turn that into deletions.
                if (missing.length > 20 && missing.length > ackSet.size * 0.5) { window.__keyAck[col] = cur; return; }
                gone[col] = missing;
            });
            Object.keys(gone).forEach((col) => {
                const at = Date.now();
                const marks = gone[col].map((k) => (k.startsWith('c:') ? { code: k.slice(2) } : k.startsWith('t:') ? { token: k.slice(2) } : { id: k.slice(2) }))
                    .map((m) => ({ ...m, _deleted: true, updatedAt: at }));
                body[col] = (body[col] || payload[col]).concat(marks);
            });
            window.__fieldAck = window.__fieldAck || new Map();
            const times = {};
            const fieldSigs = new Map();
            Object.keys(payload).forEach((f) => {
                if (f === 'updatedAt' || f === '_fieldTimes' || MERGED.has(f) || payload[f] === undefined) return;
                const sg = pushSigOf(payload[f]);
                fieldSigs.set(f, sg);
                if (window.__fieldAck.has(f) && window.__fieldAck.get(f) !== sg) times[f] = Date.now();
            });
            if (Object.keys(times).length) body._fieldTimes = times;
            // which device this is, so the server can give it a till number (see generateReceiptRef)
            try { body._till = getOrCreateDeviceId(); } catch (e) { /* no id: the device keeps its own reference form */ }
            // and which app release it runs (device list in Settings and the Owner Console)
            try { body._dev = { v: window.__APP_RELEASE || '', app: (location.pathname.split('/')[1] || 'shop').slice(0, 20) }; } catch (e) { /* optional */ }
            return {
                body,
                more,
                commit() {
                    Object.keys(pending).forEach((f) => { const m = window.__pushAck[f] || (window.__pushAck[f] = new Map()); pending[f].forEach((sg, k) => m.set(k, sg)); });
                    fieldSigs.forEach((sg, f) => { window.__fieldAck.set(f, sg); });
                    Object.keys(keysNow).forEach((c) => { window.__keyAck[c] = keysNow[c]; });
                    saveKeyAck();
                    window.__pushFailed = false;
                    try { if (typeof window.salesJournalSent === 'function') window.salesJournalSent(sentVersions); } catch (e) { /* never block a push */ }
                },
            };
        }

//@fn pushBacklogAfter
// After a push the server accepted (zip 129): more batches left -> send the next one right away; none left -> the backlog is done.
function pushBacklogAfter(slim) {
            window.__pushBacklog = !!(slim && slim.more);
            if (window.__pushBacklog) {
                setTimeout(() => {
                    try { if (typeof queuePush === 'function') queuePush(); else if (typeof pushNow === 'function') pushNow(); } catch (e) { /* the poll sends it */ }
                }, window.__pushBatchGapMs != null ? window.__pushBatchGapMs : 250);
            } else if ((window.__pushBatchScale || 1) < 1) {
                window.__pushBatchScale = Math.min(1, (window.__pushBatchScale || 1) * 2);    // it went through: grow back
            }
        }

//@fn pushShrinkBatches
// A push that timed out, or that the server called too large: half the batch size next time (down to 1/16), so it fits the line.
function pushShrinkBatches() {
            window.__pushBatchScale = Math.max(1 / 16, (window.__pushBatchScale || 1) / 2);
        }

//@fn pushErrorCode
async function pushErrorCode(res) {
            try { const b = await res.clone().json(); return (b && b.code) || ''; } catch (e) { return ''; }
        }

//@fn syncHaveCheck
// Before this session's first push (zip 129): ask the server which of this device's sales / stock changes / returns / expenses it
// ALREADY holds, in the same version (pushed earlier by this device, or by another one) — /api/sync-have. Those are marked
// acknowledged and never uploaded again. Once per session per log; a server that cannot answer (offline, an older shop database)
// simply leaves the batching to do the work.
async function syncHaveCheck(payload) {
            if (window.__haveChecked === 'done' || typeof window.salesJournalSig !== 'function') return;
            if (window.__haveCheckBusy) return window.__haveCheckBusy;
            window.__haveCheckBusy = (async () => {
                const FIELDS = ['salesLog', 'stockMovementLog', 'returns', 'expenses'];
                window.__pushAck = window.__pushAck || {};
                let complete = true;
                for (const f of FIELDS) {
                    const arr = payload && Array.isArray(payload[f]) ? payload[f] : [];
                    const ack = window.__pushAck[f] || (window.__pushAck[f] = new Map());
                    const ask = [];
                    arr.forEach((r) => { if (r && r.id != null) { const k = pushKeyOf(r); if (k != null && ack.get(k) !== pushSigOf(r)) ask.push(r); } });
                    for (let i = 0; i < ask.length; i += 2000) {
                        const part = ask.slice(i, i + 2000);
                        const ctrl = new AbortController();
                        const timer = setTimeout(() => ctrl.abort(), 20000);
                        try {
                            const res = await fetch(apiUrl('/api/sync-have'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ col: f, ids: part.map((r) => String(r.id)) }), signal: ctrl.signal });
                            if (res.status === 404 || res.status === 501) { window.__haveChecked = 'done'; return; }   // not available here: batching only
                            if (!res.ok) { complete = false; break; }
                            const have = ((await res.json()) || {}).have || {};
                            const confirmed = [];
                            part.forEach((r) => { const v = have[String(r.id)]; if (v != null && v === window.salesJournalSig(r)) { ack.set(pushKeyOf(r), pushSigOf(r)); confirmed.push(r); } });
                            try { if (confirmed.length && typeof window.salesJournalSeenRecords === 'function') window.salesJournalSeenRecords(f, confirmed); } catch (e) { /* bookkeeping */ }
                        } catch (e) { complete = false; break; } finally { clearTimeout(timer); }
                    }
                    if (!complete) break;
                }
                if (complete) window.__haveChecked = 'done';
            })();
            try { await window.__haveCheckBusy; } finally { window.__haveCheckBusy = null; }
        }

//@fn handleOwnerNotice
function handleOwnerNotice(notice) {
            // A payment reminder the owner (mydukapos) sent to THIS business's admin. It arrives with the license check that every till already
            // makes, shows as a banner across the top for the admin only (a staff member signed in as themselves never sees it), and stays
            // until the admin taps OK — on any device — after which it stops for everyone.
            const banner = document.getElementById('owner-notice-banner');
            const hide = () => { if (banner) banner.remove(); };
            if (!notice || !notice.id) { hide(); return; }
            let seen = [];
            try { seen = JSON.parse(localStorage.getItem('owner_notice_seen') || '[]'); } catch (e) { seen = []; }
            if (seen.includes(notice.id)) { hide(); return; }
            const isAdmin = typeof currentServer === 'undefined' || !currentServer;
            const shown = (id) => { const el = document.getElementById(id); return !el || el.style.display === 'none'; };
            if (!isAdmin || !shown('login-screen') || !shown('registration-screen')) { hide(); return; }
            if (banner && banner.dataset.noticeId === notice.id) return;
            hide();
            const el = document.createElement('div');
            el.id = 'owner-notice-banner';
            el.dataset.noticeId = notice.id;
            el.setAttribute('role', 'alert');
            el.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:2147483000; background:#fff3cd; color:#5c4400; border-bottom:2px solid #f0ad4e; padding:12px 14px; display:flex; gap:12px; align-items:center; box-shadow:0 2px 8px rgba(0,0,0,0.25); font-size:14px; line-height:1.4;';
            const text = document.createElement('div');
            text.style.cssText = 'flex:1; min-width:0;';
            const title = document.createElement('div');
            title.style.cssText = 'font-weight:700; margin-bottom:2px;';
            title.textContent = '💰 Payment reminder from mydukapos';
            const msg = document.createElement('div');
            msg.textContent = notice.message;
            text.appendChild(title); text.appendChild(msg);
            const ok = document.createElement('button');
            ok.type = 'button';
            ok.textContent = 'OK';
            ok.style.cssText = 'flex-shrink:0; padding:8px 18px; border:none; border-radius:6px; background:#f0ad4e; color:#3d2b00; font-weight:700; cursor:pointer;';
            ok.onclick = () => dismissOwnerNotice(notice.id);
            el.appendChild(text); el.appendChild(ok);
            document.body.appendChild(el);
        }

//@fn dismissOwnerNotice
async function dismissOwnerNotice(id) {
            try {
                const seen = JSON.parse(localStorage.getItem('owner_notice_seen') || '[]');
                seen.push(id);
                localStorage.setItem('owner_notice_seen', JSON.stringify(seen.slice(-20)));
            } catch (e) { /* the server-side acknowledgement below still stops it */ }
            const banner = document.getElementById('owner-notice-banner');
            if (banner) banner.remove();
            try {
                await fetch(apiUrl('/api/owner-notice'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
            } catch (e) { /* offline: this device won't show it again; the server learns on the next dismissal */ }
        }

//@fn loadKeyAck
function loadKeyAck() {
            // Which records of each deletable list this device last agreed with the server about, so a record that is no longer in the list
            // can be told apart from one that was never there. Kept in localStorage so a refresh right after a delete doesn't forget it.
            try {
                const raw = localStorage.getItem('sync_key_ack_v1:' + location.pathname);
                if (!raw) return {};
                const o = JSON.parse(raw), out = {};
                Object.keys(o).forEach((c) => { if (Array.isArray(o[c])) out[c] = new Set(o[c]); });
                return out;
            } catch (e) { return {}; }
        }

//@fn saveKeyAck
function saveKeyAck() {
            try {
                clearTimeout(window.__keyAckSaveT);
                window.__keyAckSaveT = setTimeout(() => {
                    try {
                        const o = {};
                        Object.keys(window.__keyAck || {}).forEach((c) => { const a = Array.from(window.__keyAck[c]); if (a.length <= 20000) o[c] = a; });
                        localStorage.setItem('sync_key_ack_v1:' + location.pathname, JSON.stringify(o));
                    } catch (e) { /* housekeeping only */ }
                }, 2000);
            } catch (e) { /* housekeeping only */ }
        }

//@fn ackLocalFields
function ackLocalFields() {
            // Called just after a pulled payload has been applied: from now on this device's whole-value settings are "in agreement with
            // the server" (the ones the app applied equal the server's; the ones it didn't are its own). Anything it changes after this
            // is what gets stamped as a real change on the next push.
            try {
                const p = collectSyncPayload();
                window.__fieldAck = window.__fieldAck || new Map();
                Object.keys(p).forEach((f) => { if (f !== 'updatedAt' && p[f] !== undefined) window.__fieldAck.set(f, pushSigOf(p[f])); });
                // ...and which records of the deletable lists exist now (a record missing later = the person deleted it; see slimPayloadForPush)
                if (!window.__keyAck) window.__keyAck = loadKeyAck();
                ['inventory', 'products', 'customers', 'suppliers', 'deliveryZones', 'deliveryAgents', 'offers', 'bills', 'debts', 'recurringExpenses', 'contracts', 'pendingInvites', 'patients', 'patientNotes', 'labResults', 'appointments', 'queue', 'institutions', 'rawMaterials'].forEach((col) => {
                    if (!Array.isArray(p[col])) return;
                    const set = new Set();
                    p[col].forEach((r) => { const k = pushKeyOf(r); if (k != null) set.add(k); });
                    window.__keyAck[col] = set;
                });
                saveKeyAck();
            } catch (e) { /* housekeeping only */ }
        }

//@fn notePushHttp
// Called when the server ANSWERED a push with an error. "Busy" answers (another device's save landing at the same moment, the shop
// being moved to its own database, a brief server hiccup) are temporary: trackPush sends again by itself within seconds. Anything
// else (refused: licence, too large) keeps the longer wait. (zip 123)
function notePushHttp(res) {
            const st = (res && res.status) || 0;
            const busy = st === 408 || st === 425 || st === 429 || st >= 500;
            window.__pushFailKind = busy ? 'busy' : 'http';
            let ra = 0;
            try { ra = Number(res.headers.get('Retry-After')) || 0; } catch (e) { /* none */ }
            window.__pushRetryAfterMs = ra > 0 ? Math.min(30000, ra * 1000) : 0;
            return busy;
        }

//@fn trackPush
async function trackPush(fn) {
            // Wraps every push so the app always knows whether it has changes the server has not acknowledged yet:
            // queued (see queuePush), in flight, or failed. commit() (called only when the server says OK) clears "failed".
            window.__pushInFlight = (window.__pushInFlight || 0) + 1;
            window.__pushQueued = false;
            try { if (typeof window.salesJournalPushStarted === 'function') window.salesJournalPushStarted(); } catch (e) { /* bookkeeping */ }
            const wasFailing = (window.__pushFails || 0) > 0;
            const jitter = (ms) => ms + Math.floor(Math.random() * ms * 0.6);
            try {
                let r;
                // A "busy" answer is tried again right here, after a short random pause (so two devices that collided do not collide again),
                // up to 3 times — most collisions are over after the first. (zip 123)
                for (let attempt = 0; ; attempt++) {
                    window.__pushFailed = true;
                    window.__pushFailKind = '';
                    r = await fn();
                    if (!window.__pushFailed || window.__pushFailKind !== 'busy' || attempt >= 2) break;
                    markSync('syncing');
                    await new Promise((res) => setTimeout(res, window.__pushRetryAfterMs || jitter(window.__pushBusyRetryMs != null ? window.__pushBusyRetryMs : 1200)));
                }
                try {
                    if (window.__pushFailed) {
                        if (!wasFailing) {                                             // one line per failure streak, not one per attempt
                            window.__pushFailSince = Date.now();
                            syncJournal('failed', window.__pushFailKind === 'network' ? 'no answer from the server (offline?) — kept on this device, sending again automatically'
                                : window.__pushFailKind === 'busy' ? 'the server was busy — kept on this device, sending again automatically in a few seconds'
                                : 'the server refused the change — kept on this device, sending again automatically');
                        }
                    } else if (wasFailing) {
                        syncJournal('retry', 'sent automatically after an earlier failure — nothing lost, the server applies each change once');
                        window.__pushFailSince = 0;
                    } else {
                        // ordinary sends are summarised (at most one line per 30 minutes), so the log shows sync activity without drowning the audit
                        const n = (parseInt(localStorage.getItem('pos_sync_sent_count') || '0', 10) || 0) + 1;
                        const last = parseInt(localStorage.getItem('pos_sync_sent_logged_at') || '0', 10) || 0;
                        if (Date.now() - last > 30 * 60000) { syncJournal('sent', `${n} send${n === 1 ? '' : 's'} to the server since the last entry`); localStorage.setItem('pos_sync_sent_count', '0'); localStorage.setItem('pos_sync_sent_logged_at', String(Date.now())); }
                        else localStorage.setItem('pos_sync_sent_count', String(n));
                    }
                } catch (e) { /* diagnostics only */ }
                return r;
            }
            finally {
                window.__pushInFlight = Math.max(0, (window.__pushInFlight || 1) - 1);
                // A push that keeps failing is sent again BY ITSELF with a growing pause — busy: ~2 s, 4 s, 8 s (max 10 s); refused or
                // offline: 4 s, 8 s, 15 s — instead of waiting for someone to do something. Tapping the sync dot sends at once (syncRetryNow).
                clearTimeout(window.__pushRetryTimer);
                if (window.__pushFailed) {
                    window.__pushFails = (window.__pushFails || 0) + 1;
                    const wait = window.__pushFailKind === 'busy'
                        ? Math.max(window.__pushRetryAfterMs || 0, jitter(Math.min(10000, 1000 * Math.pow(2, window.__pushFails))))
                        : Math.min(15000, 2000 * Math.pow(2, window.__pushFails));
                    window.__pushBackoffUntil = Date.now() + wait;
                    if (window.__pushFailKind !== 'http' || window.__pushFails < 6) {
                        window.__pushRetryTimer = setTimeout(() => {
                            try { if (!(window.__pushInFlight > 0) && typeof hasUnsyncedWork === 'function' && hasUnsyncedWork()) flushPendingPush(); } catch (e) { /* the poll will */ }
                        }, wait + 50);
                    }
                } else { window.__pushFails = 0; window.__pushBackoffUntil = 0; }
            }
        }

//@fn syncRetryNow
// "Send now" — tapping the sync dot (or anything else that wants it): forget any pause after a failure and send + fetch right away.
async function syncRetryNow() {
            window.__pushBackoffUntil = 0;
            window.__pushFails = window.__pushFails ? 1 : 0;        // keep "was failing" so success is logged as a retry
            clearTimeout(window.__pushRetryTimer);
            markSync('syncing');
            try {
                if (typeof flushThenPull === 'function') return await flushThenPull();
                await flushPendingPush();
                if (typeof pullState === 'function') await pullState(); else if (typeof pullFromServer === 'function') await pullFromServer();
            } catch (e) { /* the automatic retry carries on */ }
        }

//@fn markLocalDirty
// Persists (synchronously, to localStorage — not just an in-memory flag)
// that this device has a local change the server hasn't acknowledged yet.
// The in-memory __pushQueued/__pushInFlight/__pushFailed flags below are
// reset by any page reload or crash, so on their own they can't tell a
// fresh boot "the last edit before that reload never actually reached the
// server" — which is exactly the case where the very first pull after
// login/reload would apply the server's OLDER copy on top of an edit that
// was only ever saved locally, making it look like it silently reverted.
// This counter survives the reload; see hasUnsyncedWork() and pushNow().
function markLocalDirty() {
            try { localStorage.setItem('pos_dirty_seq', String((parseInt(localStorage.getItem('pos_dirty_seq') || '0', 10) || 0) + 1)); } catch (e) { /* best effort */ }
        }

//@fn ackLocalDirty
// Records, durably, which dirty-sequence number a push actually delivered.
// Called with the sequence read at the START of that push — never the
// current one — so an edit that landed WHILE the push was in flight (and
// so was never in its payload) correctly keeps the device "still dirty"
// until a later push covers it too.
function ackLocalDirty(seqAtPushStart) {
            try { localStorage.setItem('pos_acked_seq', seqAtPushStart); } catch (e) { /* best effort */ }
        }

//@fn hasUnsyncedWork
function hasUnsyncedWork() {
            let persisted = false;
            try { persisted = (parseInt(localStorage.getItem('pos_dirty_seq') || '0', 10) || 0) > (parseInt(localStorage.getItem('pos_acked_seq') || '0', 10) || 0); } catch (e) { /* best effort */ }
            return !!(window.__pushQueued || window.__pushInFlight > 0 || window.__pushFailed === true || window.__pushBacklog === true || persisted);
        }

//@fn flushPendingPush
async function flushPendingPush() {
            // Send what this device has NOW, before anything from the server is applied on top of it. Returns true when the server has it.
            try { if (typeof pushTimer !== 'undefined' && pushTimer) clearTimeout(pushTimer); } catch (e) { /* none */ }
            if (window.__pushInFlight > 0) {                         // one is already on its way: wait for it, then check again
                for (let i = 0; i < 40 && window.__pushInFlight > 0; i++) await new Promise((r) => setTimeout(r, 100));
            }
            if (!hasUnsyncedWork()) return true;
            if (window.__pushBackoffUntil > Date.now() && window.__pushFailed) {                  // waiting out a failed attempt...
                // ...but if it failed because there was NO ANSWER (the connection dropped), the wait ends the moment the server answers again:
                // ask it (a few bytes) and push now. Before, a short outage could leave the badge on "Offline" for up to a minute after the
                // internet had returned. A push the server answered and REFUSED (too big, busy) keeps its wait, so it isn't re-sent every poll.
                if (window.__pushFailKind !== 'network') return false;
                const status = await probeServer(5000);
                if (status === 0 || status >= 500) { markSync(status === 0 ? 'offline' : 'error'); return false; }
                window.__pushBackoffUntil = 0; window.__pushFails = 0;
            }
            const ok = await (typeof pushNow === 'function' ? pushNow() : (typeof doPush === 'function' ? (await doPush(), !window.__pushFailed) : true));
            return !!ok;
        }

//@fn snapshotExtraSyncedFields
function snapshotExtraSyncedFields() {
            ensureExtraSyncedFieldsInitialized();
            extraSyncSnapshot = {};
            extraSyncedFields.forEach(({ name, getter, keyField }) => {
                let arr; try { arr = getter(); } catch (e) { return; }
                if (!Array.isArray(arr)) return;
                arr.forEach((r) => {
                    if (!r || r[keyField] == null) return;
                    extraSyncSnapshot[`${name}:${r[keyField]}`] = extraRecSig(name, r);
                });
            });
        }

//@fn snapshotInventorySync
function snapshotInventorySync() {
            invSyncSnapshot = {};
            (Array.isArray(inventory) ? inventory : []).forEach((it) => {
                if (!it || it.code == null) return;
                invSyncSnapshot[it.code] = stockRecSig(it);
            });
        }

//@fn soldQtyAfter
function soldQtyAfter(code, dateStr) {
            return stockReportTotals('soldAfter', dateStr).get(code) || 0;
        }

//@fn soldQtyWithinRange
function soldQtyWithinRange(code, fromStr, toStr) {
            return stockReportTotals('soldIn', fromStr, toStr).get(code) || 0;
        }

//@fn staffExpensesAccessLevel
function staffExpensesAccessLevel(member) {
            if (!member) return 'full';
            const roles = Array.isArray(member.roles) ? member.roles : [];
            if (roles.includes('profits-tab')) return 'full';
            if (roles.includes('expenses-add-only')) return 'expenses-only';
            return 'none';
        }

//@fn staffShiftsFor
function staffShiftsFor(id) {
            return staffShifts.filter(sh => sh.staffId === id).sort((a, b) => b.clockIn - a.clockIn);
        }

//@fn stampDirtyExtraSyncedFields
function stampDirtyExtraSyncedFields() {
            ensureExtraSyncedFieldsInitialized();
            extraSyncedFields.forEach(({ name, getter, keyField }) => {
                let arr; try { arr = getter(); } catch (e) { return; }
                if (!Array.isArray(arr)) return;
                arr.forEach((r) => {
                    if (!r || r[keyField] == null) return;
                    const sig = extraRecSig(name, r);
                    if (extraSyncSnapshot[`${name}:${r[keyField]}`] !== sig) {
                        r.updatedAt = Date.now();
                    }
                });
            });
        }

//@fn stampDirtyInventory
function stampDirtyInventory() {
            // Any stock change this device made without itemising it becomes a movement first (see reconcileLocalStockChanges).
            try { reconcileLocalStockChanges(); } catch (e) { /* never block a push */ }
            (Array.isArray(inventory) ? inventory : []).forEach((it) => {
                if (!it || it.code == null) return;
                const sig = stockRecSig(it);
                if (invSyncSnapshot[it.code] !== sig) {
                    it.updatedAt = Date.now();
                }
            });
        }

//@fn stockLedgerOn
// STOCK LEDGER (zip 118). True once this shop's server has said it applies stock movements exactly once (the `_ledger` flag on a
// pull, `ledger` on a push reply — see applyStockLedger in functions/api/_merge.js). Until then the app behaves exactly as before,
// so a shop whose server was not updated yet is never switched to rules its server doesn't follow.
function stockLedgerOn() {
            try { return localStorage.getItem('pos_stock_ledger_v1') === '1'; } catch (e) { return false; }
        }

//@fn stockLedgerMark
function stockLedgerMark(on) {
            // returns true only when this call switched the ledger on
            if (!on || stockLedgerOn()) return false;
            try { localStorage.setItem('pos_stock_ledger_v1', '1'); localStorage.setItem('pos_stock_ledger_since', String(Date.now())); } catch (e) { /* retried on the next sync */ }
            // fetch the whole shop once more, so every item arrives with the server's own figures (_sq) to compare against
            try { localStorage.setItem('pos_last_synced_at', '0'); } catch (e) { /* the next change brings them anyway */ }
            try { if (typeof snapshotInventorySync === 'function') snapshotInventorySync(); } catch (e) { /* housekeeping only */ }
            try { if (typeof snapshotProductsSync === 'function') snapshotProductsSync(); } catch (e) { /* Aqua POS only */ }
            try { if (typeof snapshotExtraSyncedFields === 'function') snapshotExtraSyncedFields(); } catch (e) { /* housekeeping only */ }
            return true;
        }

//@fn stockRecSig
// What counts as "this device edited this item" for the per-record merge. With the ledger on, stock figures are NOT part of it:
// the server owns them and only moves them by movements, so selling an item no longer makes this device's whole (maybe stale)
// copy of it look like the newest edit — which is what used to put back another till's price/name change after a sale.
function stockRecSig(it) {
            const { updatedAt, ...rest } = it || {};
            if (!stockLedgerOn()) return JSON.stringify(rest);
            const c = { ...rest };
            ['qty', 'pieceQty', '_sq', '_sp', '_sv', '_ct'].forEach((k) => { delete c[k]; });
            if (Array.isArray(c.variants)) c.variants = c.variants.map((v) => { if (!v || typeof v !== 'object') return v; const { qty, _sq, _sv, _ct, ...vr } = v; return vr; });
            return JSON.stringify(c);
        }

//@fn stockMoveDelta
// How much a movement ACTUALLY changed the stock: the server's own figures when it has processed it (a duplicate, a sale already
// covered by a later stock take = 0), otherwise the movement's own delta. Reports use this so they agree with the real stock.
function stockMoveDelta(m) {
            if (m && m._srv && typeof m._srv === 'object') {
                if (m._srv.applied === false) return 0;
                if (typeof m._srv.after === 'number' && typeof m._srv.before === 'number') return Math.round((m._srv.after - m._srv.before) * 1000) / 1000;
            }
            return Number(m && m.delta) || 0;
        }

//@fn stockPendingMoves
// This device's movements the server has not processed yet (made by this build: `lg`; processed ones carry the server's `_srv`).
// Also a movement WITHOUT `lg` made after the ledger was switched on: it came from a tab still running an older release on this same
// device (zip 121) — the server applies it exactly once all the same, so until then it is pending like any other.
function stockPendingMoves(exceptIds) {
            const log = (typeof stockMovementLog !== 'undefined' && Array.isArray(stockMovementLog)) ? stockMovementLog : [];
            const t = (m) => { const x = Date.parse(m.timestamp); return isFinite(x) ? x : 0; };
            let since = 0;
            try {
                since = Number(localStorage.getItem('pos_stock_ledger_since') || 0);
                if (!since && stockLedgerOn()) { since = Date.now(); localStorage.setItem('pos_stock_ledger_since', String(since)); }  // switched on by an earlier release
            } catch (e) { /* lg-only */ }
            const pending = (m) => m.lg || (since && !m.kind && typeof m.delta === 'number' && m.delta !== 0 && t(m) > since);
            return log.filter((m) => m && !m._srv && m.id != null && m.code != null && pending(m) && !(exceptIds && exceptIds.has(String(m.id))))
                .sort((a, b) => t(a) - t(b));
        }

//@fn stockSimulate
// base (the server's figure) + this device's pending movements, applied the way the server will apply them (a count is absolute).
function stockSimulate(base, moves) {
            let v = Number(base) || 0;
            (moves || []).forEach((m) => { v = m.kind === 'count' ? Number(m.counted) || 0 : v + (Number(m.delta) || 0); });
            return Math.round(v * 1000) / 1000;
        }

//@fn stockMovesByKey
function stockMovesByKey(moves) {
            const by = new Map();
            (moves || []).forEach((m) => { const k = m.code + '|' + (m.unit === 'pieceQty' ? 'pieceQty' : 'qty'); if (!by.has(k)) by.set(k, []); by.get(k).push(m); });
            return by;
        }

//@fn reconcileLocalStockChanges
// Safety net for the ledger: every stock change must reach the server as a movement, because the server ignores the plain number.
// Almost every screen already logs one; for anything that changed a quantity WITHOUT logging it, the difference between what this
// device shows and (the server's last figure `_sq` + this device's pending movements) is logged once as a correction movement, with
// its own id — so it is applied once, like any other movement. Items the server has never stamped (`_sq` missing) are skipped.
function reconcileLocalStockChanges() {
            if (!stockLedgerOn() || typeof inventory === 'undefined' || !Array.isArray(inventory)) return 0;
            if (typeof stockMovementLog === 'undefined' || !Array.isArray(stockMovementLog)) return 0;
            const by = stockMovesByKey(stockPendingMoves());
            let made = 0;
            const check = (obj, name) => {
                [['qty', obj._sq], ['pieceQty', obj._sp]].forEach(([unit, base]) => {
                    if (typeof base !== 'number') return;
                    const diff = Math.round(((Number(obj[unit]) || 0) - stockSimulate(base, by.get(obj.code + '|' + unit))) * 1000) / 1000;
                    if (Math.abs(diff) < 1e-6) return;
                    stockMovementLog.push({
                        id: genSaleId(), lg: 1, timestamp: new Date().toISOString(), code: obj.code, name, delta: diff,
                        type: diff > 0 ? 'added' : 'removed', reason: 'Stock correction (change not itemised)', unit, auto: true,
                        by: typeof activeServerName === 'function' ? activeServerName() : '',
                    });
                    made++;
                });
            };
            inventory.forEach((it) => {
                if (!it || it.code == null || it._deleted) return;
                if (it.hasVariants && Array.isArray(it.variants) && it.variants.length > 0) {
                    it.variants.forEach((v) => { if (v && v.code != null) check(v, `${it.name} — ${v.name}`); });
                    return;
                }
                check(it, it.name);
            });
            if (made) safeSetItem('pos_stock_movement_log', JSON.stringify(stockMovementLog));
            return made;
        }

//@fn stockApplyPulledLedger
// A pull from a ledger server: its quantities are the truth. Items it never stamped get `_sq` = its figure; then this device's
// movements the server hasn't processed yet (still on their way) are laid on top, so the screen doesn't jump back and the
// safety net above doesn't mistake them for untracked changes.
function stockApplyPulledLedger(data) {
            if (!data || !Array.isArray(data.inventory)) return data;
            const serverIds = new Set();
            (Array.isArray(data.stockMovementLog) ? data.stockMovementLog : []).forEach((m) => { if (m && m.id != null) serverIds.add(String(m.id)); });
            const by = stockMovesByKey(stockPendingMoves(serverIds));
            const lay = (obj) => {
                if (typeof obj.qty === 'number' && typeof obj._sq !== 'number') obj._sq = obj.qty;
                if (typeof obj.pieceQty === 'number' && typeof obj._sp !== 'number') obj._sp = obj.pieceQty;
                ['qty', 'pieceQty'].forEach((unit) => {
                    const mv = by.get(obj.code + '|' + unit);
                    if (mv && mv.length) obj[unit] = stockSimulate(unit === 'qty' ? obj._sq : obj._sp, mv);
                });
            };
            data.inventory = data.inventory.map((r) => {
                if (!r || typeof r !== 'object' || r.code == null) return r;
                const rec = { ...r };
                if (rec.hasVariants && Array.isArray(rec.variants) && rec.variants.length > 0) {
                    rec.variants = rec.variants.map((v) => { if (!v || typeof v !== 'object' || v.code == null) return v; const c = { ...v }; lay(c); return c; });
                    rec.qty = Math.round(rec.variants.reduce((s, v) => s + (Number(v && v.qty) || 0), 0) * 1000) / 1000;
                } else lay(rec);
                return rec;
            });
            return data;
        }

//@fn stockKeyMoves
// Gives the stock movements logged since `fromLen` a DETERMINISTIC id built from the business event they belong to (e.g. the sale
// being voided). The same event done again — a double tap, or a second till that had not seen the first one yet — then produces the
// SAME movement ids, which the server already holds, so the stock changes once (see applyStockLedger). Returns how many were keyed.
function stockKeyMoves(fromLen, key) {
            if (typeof stockMovementLog === 'undefined' || !Array.isArray(stockMovementLog) || !key) return 0;
            let n = 0;
            for (let i = Math.max(0, fromLen || 0); i < stockMovementLog.length; i++) {
                const m = stockMovementLog[i];
                if (!m || typeof m !== 'object') continue;
                m.id = `${key}:${m.code}:${m.unit === 'pieceQty' ? 'p' : 'q'}:${n}`;
                n++;
            }
            if (n) safeSetItem('pos_stock_movement_log', JSON.stringify(stockMovementLog));
            return n;
        }

//@fn stockMoveAuditText
// One line for the Audit tab that says what REALLY happened to the stock: the server's confirmed before -> after, a count shown
// as a count (not a +/- guess), a movement that did not change stock marked as such, and one still on its way marked as pending.
// A retry/duplicate is never a second line: the server keeps one movement per id.
function stockMoveAuditText(e) {
            const q = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
            const pcs = e.unit === 'pieceQty' ? ' pcs' : '';
            const srv = e._srv && typeof e._srv === 'object' ? e._srv : null;
            const change = srv && typeof srv.before === 'number' && typeof srv.after === 'number' ? ` (${q(srv.before)} → ${q(srv.after)}${pcs})` : '';
            const head = e.kind === 'count'
                ? `${e.name || e.code}: counted ${q(e.counted)}${pcs}${srv ? change : ` (showed ${q(e.before)})`}`
                : `${e.name || e.code}: ${e.delta > 0 ? '+' : ''}${q(e.delta)}${pcs}${change}`;
            let tail = '';
            if (srv && srv.applied === false) {
                tail = srv.reason === 'older-count' ? ' · NOT applied: a later stock take of this item was already recorded'
                    : srv.reason === 'before-count' ? ' · NOT applied again: already covered by a later stock take'
                    : srv.reason === 'no-item' ? ' · NOT applied: item not found' : ' · NOT applied';
            } else if (srv && srv.stale) tail = ' · counted against an out-of-date figure (physical count applied)';
            else if (!srv && e.lg && stockLedgerOn()) tail = ' · waiting to sync';
            return `${head} — ${e.reason || ''}${tail}`;
        }

//@fn aquaCellList
// Aqua POS stock CELLS on this device (see CELL_SPECS in functions/api/_merge.js): every product's stock at every site, every
// bottle-tracked bale's bottle count at every site, every tank's litres, every raw material's quantity. Each entry says where
// the number lives, what it is now, and the server's last confirmed figure for it (`base`, from `_ss`; undefined = never stamped).
function aquaCellList() {
            const out = [];
            const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
            const siteName = (id) => { try { const x = (typeof sites !== 'undefined' ? sites : []).find((st) => st.id === id); return x ? x.name : id; } catch (e) { return id; } };
            (typeof products !== 'undefined' && Array.isArray(products) ? products : []).forEach((p) => {
                if (!p || p.code == null || p._deleted) return;
                const k = p.id != null ? 'id:' + p.id : 'code:' + p.code;
                ['stock', 'bottleStockBySite'].forEach((f) => {
                    const cur = isObj(p[f]) ? p[f] : {};
                    const ss = isObj(p._ss) && isObj(p._ss[f]) ? p._ss[f] : null;
                    new Set([...Object.keys(cur), ...Object.keys(ss || {})]).forEach((site) => {
                        out.push({ cell: { c: 'products', k, f, s: site }, rec: p, value: Number(cur[site]) || 0, base: ss && typeof ss[site] === 'number' ? ss[site] : undefined,
                            label: `${p.name}${f === 'bottleStockBySite' ? ' (bottles)' : ''} @ ${siteName(site)}`, site });
                    });
                });
            });
            (typeof tanks !== 'undefined' && Array.isArray(tanks) ? tanks : []).forEach((t) => {
                if (!t || t.id == null || t._deleted || t.infinite) return;
                const ss = isObj(t._ss) ? t._ss.currentVolumeLiters : undefined;
                out.push({ cell: { c: 'tanks', k: 'id:' + t.id, f: 'currentVolumeLiters' }, rec: t, value: Number(t.currentVolumeLiters) || 0, base: typeof ss === 'number' ? ss : undefined,
                    label: `${t.name || 'Tank'} (litres) @ ${siteName(t.siteId)}`, site: t.siteId });
            });
            (typeof rawMaterials !== 'undefined' && Array.isArray(rawMaterials) ? rawMaterials : []).forEach((m) => {
                if (!m || m.id == null || m._deleted || m.removed) return;
                const ss = isObj(m._ss) ? m._ss.stockQty : undefined;
                out.push({ cell: { c: 'rawMaterials', k: 'id:' + m.id, f: 'stockQty' }, rec: m, value: Number(m.stockQty) || 0, base: typeof ss === 'number' ? ss : undefined,
                    label: `${m.name} @ ${siteName(m.siteId)}`, site: m.siteId });
            });
            return out;
        }

//@fn aquaCellKey
function aquaCellKey(cell) { return `${cell.c}|${cell.k}|${cell.f}|${cell.s == null ? '' : cell.s}`; }

//@fn aquaPendingByCell
// This device's cell movements the server has not processed yet, grouped by cell, oldest first.
function aquaPendingByCell(exceptIds) {
            const log = (typeof stockMovementLog !== 'undefined' && Array.isArray(stockMovementLog)) ? stockMovementLog : [];
            const t = (m) => { const x = Date.parse(m.timestamp); return isFinite(x) ? x : 0; };
            const by = new Map();
            log.filter((m) => m && m.cell && m.lg && !m._srv && m.id != null && !(exceptIds && exceptIds.has(String(m.id))))
                .sort((a, b) => t(a) - t(b))
                .forEach((m) => { const k = aquaCellKey(m.cell); if (!by.has(k)) by.set(k, []); by.get(k).push(m); });
            return by;
        }

//@fn aquaSimulateCell
// The server's figure plus pending movements, applied as the server applies them (a count is absolute; never below zero).
function aquaSimulateCell(base, moves) {
            let v = Number(base) || 0;
            (moves || []).forEach((m) => { v = Math.max(0, m.kind === 'count' ? Number(m.counted) || 0 : v + (Number(m.delta) || 0)); });
            return Math.round(v * 1000) / 1000;
        }

//@fn aquaReconcileCells
// Aqua's screens change stock in many places (sales, production, dispatch, bottles, tanks, materials) by editing the numbers
// directly. With the ledger on, what reaches the server is, per cell, ONE movement for the net change since the server's last
// confirmed figure (+ this device's movements still on their way) — with its own id, so it is applied once whatever is retried
// or re-sent, and a stale device's old numbers can no longer overwrite another site's newer ones.
function aquaReconcileCells() {
            if (!stockLedgerOn() || typeof stockMovementLog === 'undefined' || !Array.isArray(stockMovementLog)) return 0;
            try { if (typeof commitQtyView === 'function' && typeof activeSiteId !== 'undefined') commitQtyView(activeSiteId); } catch (e) { /* the mirror is committed on save anyway */ }
            const pending = aquaPendingByCell();
            let made = 0;
            aquaCellList().forEach((x) => {
                if (typeof x.base !== 'number') return;                         // never confirmed by the server yet: sent as-is (initial)
                const diff = Math.round((x.value - aquaSimulateCell(x.base, pending.get(aquaCellKey(x.cell)))) * 1000) / 1000;
                if (Math.abs(diff) < 1e-6) return;
                stockMovementLog.push({
                    id: genSaleId(), lg: 1, timestamp: new Date().toISOString(), cell: x.cell, delta: diff, name: x.label, site: x.site,
                    type: diff > 0 ? 'added' : 'removed', reason: 'Stock change', by: typeof activeServerName === 'function' ? activeServerName() : '',
                });
                made++;
            });
            if (made) safeSetItem('aqua_stock_movement_log', JSON.stringify(stockMovementLog));
            return made;
        }

//@fn aquaApplyPulledCells
// A pull from a ledger server: its cell figures are the truth. Records it never stamped get `_ss` = its figures; then this
// device's cell movements still on their way are laid on top (same as stockApplyPulledLedger for the other apps).
function aquaApplyPulledCells(data) {
            if (!data) return data;
            const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
            const serverIds = new Set();
            (Array.isArray(data.stockMovementLog) ? data.stockMovementLog : []).forEach((m) => { if (m && m.id != null) serverIds.add(String(m.id)); });
            const pending = aquaPendingByCell(serverIds);
            const lay = (rec, c, k, maps, scalars) => {
                const r = { ...rec };
                const ss = isObj(r._ss) ? { ...r._ss } : {};
                maps.forEach((f) => {
                    if (!isObj(r[f])) return;
                    r[f] = { ...r[f] };
                    if (!isObj(ss[f])) ss[f] = { ...r[f] };
                    Object.keys(r[f]).forEach((site) => {
                        const mv = pending.get(aquaCellKey({ c, k, f, s: site }));
                        if (mv && mv.length) r[f][site] = aquaSimulateCell(typeof ss[f][site] === 'number' ? ss[f][site] : r[f][site], mv);
                    });
                });
                scalars.forEach((f) => {
                    if (typeof r[f] !== 'number') return;
                    if (typeof ss[f] !== 'number') ss[f] = r[f];
                    const mv = pending.get(aquaCellKey({ c, k, f }));
                    if (mv && mv.length) r[f] = aquaSimulateCell(ss[f], mv);
                });
                r._ss = ss;
                return r;
            };
            if (Array.isArray(data.products)) data.products = data.products.map((p) => (p && p.code != null ? lay(p, 'products', p.id != null ? 'id:' + p.id : 'code:' + p.code, ['stock', 'bottleStockBySite'], []) : p));
            if (Array.isArray(data.tanks)) data.tanks = data.tanks.map((t) => (t && t.id != null ? lay(t, 'tanks', 'id:' + t.id, [], ['currentVolumeLiters']) : t));
            if (Array.isArray(data.rawMaterials)) data.rawMaterials = data.rawMaterials.map((m) => (m && m.id != null ? lay(m, 'rawMaterials', 'id:' + m.id, [], ['stockQty']) : m));
            return data;
        }

//@fn stockCellFieldsOf
// Stock figures the server owns (ledger on): left out of "did this device edit this record?", so moving stock never makes a
// device's whole (maybe stale) copy of a record look like the newest edit of its name, price, capacity ...
function stockCellFieldsOf(name) {
            if (!stockLedgerOn()) return null;
            if (name === 'tanks') return ['currentVolumeLiters', '_ss', '_sv', '_ct'];
            if (name === 'rawMaterials') return ['stockQty', '_ss', '_sv', '_ct'];
            if (name === 'products') return ['stock', 'bottleStockBySite', 'siteTimes', '_ss', '_sv', '_ct'];
            return null;
        }

//@fn extraRecSig
function extraRecSig(name, r) {
            const { updatedAt, ...rest } = r || {};
            const drop = stockCellFieldsOf(name);
            if (drop) drop.forEach((f) => { delete rest[f]; });
            return JSON.stringify(rest);
        }

//@fn logStockCount
// A stock-take COUNT: an absolute "there are N" (not a +/- change), with its own immutable id, the figure this device showed
// (`before`), the stock version it saw (`baseSv`), and the stock take it belongs to. The server applies it once (see applyStockLedger).
function logStockCount(item, displayName, unit, counted, before, stocktakeId) {
            const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
            let device = '';
            try { device = localStorage.getItem('pos_device_id') || ''; } catch (e) { /* optional */ }
            const m = {
                id: genSaleId(), lg: 1, kind: 'count', timestamp: new Date().toISOString(), code: item.code, name: displayName || item.name,
                counted: r3(counted), before: r3(before), delta: r3(counted - before), type: counted >= before ? 'added' : 'removed',
                reason: 'Stock take', unit: unit === 'pieceQty' ? 'pieceQty' : 'qty', stocktakeId,
                by: typeof activeServerName === 'function' ? activeServerName() : '',
            };
            if (device) m.device = device;
            if (typeof item._sv === 'number') m.baseSv = item._sv;
            stockMovementLog.push(m);
            return m;
        }

//@fn startAdminShiftIfNeeded
function startAdminShiftIfNeeded() {
            if (!isAdminServing() || adminHasOpenShift()) return;
            staffShifts.push({
                id: generateToken(),
                staffId: ADMIN_SHIFT_ID,
                name: activeServerName(),
                clockIn: Date.now(),
                clockOut: null
            });
            safeSetItem('pos_staff_shifts', JSON.stringify(staffShifts));
            queuePush();
        }

//@fn startBackgroundCameraScan
async function startBackgroundCameraScan() {
            if (!('BarcodeDetector' in window)) {
                setCameraScanStatus('Camera scanning isn’t supported on this device/browser — use a hardware barcode scanner instead.');
                return;
            }
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                setCameraScanStatus('Camera not available on this device/browser.');
                return;
            }

            try {
                cameraScanDetector = new BarcodeDetector({
                    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'codabar', 'itf', 'qr_code'],
                });
            } catch (e) {
                // Some platforms support the interface but not every format list —
                // fall back to letting the browser pick its own supported set.
                cameraScanDetector = new BarcodeDetector();
            }

            // Highest-resolution rear camera we can get, since a sharper
            // frame is the single biggest lever on decode reliability for a
            // small/worn/angled barcode. "exact: environment" is tried
            // first (refuses to silently hand back the front camera on a
            // device where that would happen); a browser/device that
            // doesn't honor "exact" throws OverconstrainedError, which is
            // caught and retried with a plain (non-exact) preference —
            // still asks for the rear camera, just doesn't require it.
            const videoConstraintAttempts = [
                { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, advanced: [{ focusMode: 'continuous' }] },
                { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, advanced: [{ focusMode: 'continuous' }] },
                { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
                { facingMode: 'environment' },
            ];

            let stream = null, lastErr = null;
            for (const constraints of videoConstraintAttempts) {
                try {
                    stream = await navigator.mediaDevices.getUserMedia({ video: constraints });
                    break;
                } catch (e) {
                    lastErr = e;
                }
            }
            if (!stream) {
                setCameraScanStatus('Camera unavailable — permission denied, or no camera found. Check this device’s site permissions and try again.');
                return;
            }

            try {
                cameraScanStream = stream;
                const video = document.getElementById('barcode-scanner-video');
                video.srcObject = cameraScanStream;

                // A device that ignores focusMode in getUserMedia's own
                // constraints (most do — it's still poorly supported) gets
                // one more direct attempt via applyConstraints, which a
                // wider set of browsers do honor.
                const [track] = cameraScanStream.getVideoTracks();
                cameraScanTrack = track || null;
                if (track && track.getCapabilities) {
                    try {
                        const caps = track.getCapabilities();
                        if (caps.focusMode && caps.focusMode.includes('continuous')) {
                            await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
                        }
                        cameraScanTorchSupported = !!caps.torch;
                    } catch (e) {
                        // Not every device honors this — the scanner still
                        // works, it just relies on the device's own default
                        // focus behavior instead.
                    }
                }

                // Off-screen canvas the detector reads from instead of the
                // raw video — a lightweight grayscale + contrast-boost pass
                // gives the detector a cleaner black/white edge to lock onto
                // than the camera's own (often slightly washed-out, auto-
                // exposed) color feed, which noticeably helps on faded
                // receipt-paper barcodes and low-light stockrooms.
                cameraScanCanvas = document.createElement('canvas');
                cameraScanCanvasCtx = cameraScanCanvas.getContext('2d', { willReadFrequently: true });

                lastCameraScanValue = '';
                lastCameraScanTime = 0;
                // 180ms: inside the spec's 150-200ms decode-throttle window —
                // fast enough that a barcode held in front of the camera is
                // still caught almost immediately, slow enough that a mid-
                // and low-end Android device doesn't fall behind processing
                // frame after frame.
                cameraScanIntervalId = setInterval(() => runBackgroundCameraScanTick(video), 180);
                updateCameraScanStatusText();
                renderCameraScanTorchButton();
            } catch (e) {
                setCameraScanStatus('Camera unavailable — permission denied, or no camera found. Check this device’s site permissions and try again.');
            }
        }

//@fn startDeviceNetworkHeartbeat
function startDeviceNetworkHeartbeat() {
            heartbeatDeviceNetwork();
            if (!deviceNetworkHeartbeatInterval) {
                deviceNetworkHeartbeatInterval = setInterval(heartbeatDeviceNetwork, 20000);
            }
        }

//@fn startInvCellEdit
function startInvCellEdit(id, field) {
            inventoryEditingCells.add(invCellKey(id, field));
            renderInventoryTable();
            // The input doesn't exist until the render above creates it.
            requestAnimationFrame(() => {
                const el = document.querySelector(`[data-inv-cell="${invCellKey(id, field)}"]`);
                if (el) { el.focus(); el.select(); }
            });
        }

//@fn startLicensePolling
function startLicensePolling() {
            checkLicenseStatus();
            if (licensePollTimer) clearInterval(licensePollTimer);
            licensePollTimer = setInterval(checkLicenseStatus, 30000);
        }

//@fn startNewContract
function startNewContract() {
            activeContractId = null;
            document.getElementById('contract-existing-group').style.display = 'none';
            document.getElementById('contract-type-retail-btn').disabled = false;
            document.getElementById('contract-type-wholesale-btn').disabled = false;
            document.getElementById('contract-name-input').value = '';
            document.getElementById('contract-phone-input').value = '';
            setContractType('retail');
        }

//@fn startStaffShift
function startStaffShift(staffId, name) {
            staffShifts.push({ id: generateToken(), staffId, name, clockIn: Date.now(), clockOut: null });
            safeSetItem('pos_staff_shifts', JSON.stringify(staffShifts));
            queuePush();
        }

//@fn statusLabelFor
function statusLabelFor(status) {
            return { assigned: 'Assigned', picked_up: 'Picked Up', on_route: 'On Route', delivered: 'Delivered' }[status || 'assigned'] || 'Assigned';
        }

//@fn reportRowLimit
// Long on-screen report tables (zip 122): a phone lays out every cell of every row, and a 3,000-item Stock Report (33,000 cells)
// took ~13 s to appear. The first 200 rows are shown, with "Show more" / "Show all" underneath. Totals, search and printing still
// use every row. `rerender` is the name of the function that redraws the table.
function reportRowLimit(key, rows, cols, rerender) {
            const limits = window.__reportRowLimits = window.__reportRowLimits || {};
            const limit = limits[key] || 200;
            if (rows.length <= limit) return { shown: rows, moreHtml: '' };
            const next = Math.min(200, rows.length - limit);
            return {
                shown: rows.slice(0, limit),
                moreHtml: `<tr class="report-more-row"><td colspan="${cols}" style="text-align:center; padding:12px;">Showing ${limit} of ${rows.length} &nbsp;`
                    + `<button type="button" class="settings-small-btn" onclick="reportShowMore('${key}', false, '${rerender}')">Show ${next} more</button> `
                    + `<button type="button" class="settings-small-btn" onclick="reportShowMore('${key}', true, '${rerender}')">Show all</button></td></tr>`,
            };
        }

//@fn reportShowMore
function reportShowMore(key, all, rerender) {
            const limits = window.__reportRowLimits = window.__reportRowLimits || {};
            limits[key] = all ? Infinity : (limits[key] || 200) + 200;
            const fn = window[rerender];
            if (typeof fn === 'function') fn();
        }

//@fn stockReportTotals
// Per-item totals of sales and stock movements for a date window, for ALL items in ONE pass (zip 122). The Stock Report used to
// scan the whole sales history and movement log once per item per column, re-reading every date each time: with 3,000 items and
// 5,000 sales that took ~50 s on a phone. Same figures as before (same rules, same === code match). The totals are kept only
// for the current task (cleared right after), so a sale or a stock change made afterwards is always counted.
function stockReportTotals(kind, a, b) {
            let cache = window.__stockReportTotals;
            if (!cache) {
                cache = window.__stockReportTotals = new Map();
                setTimeout(() => { window.__stockReportTotals = null; }, 0);
            }
            const sl = typeof salesLog !== 'undefined' && Array.isArray(salesLog) ? salesLog.length : 0;
            const ml = typeof stockMovementLog !== 'undefined' && Array.isArray(stockMovementLog) ? stockMovementLog.length : 0;
            const ck = kind + '|' + a + '|' + (b || '') + '|' + sl + '|' + ml;
            if (cache.has(ck)) return cache.get(ck);
            const out = new Map();
            const add = (code, v) => { out.set(code, (out.get(code) || 0) + v); };
            const inWin = (key) => (kind === 'mvAfter' || kind === 'soldAfter') ? key > a : (key >= a && key <= b);
            if (kind === 'soldAfter' || kind === 'soldIn') {
                (typeof salesLog !== 'undefined' && Array.isArray(salesLog) ? salesLog : []).forEach((s) => {
                    if (!s || s.voided || !inWin(dateKey(new Date(s.timestamp)))) return;
                    (s.items || []).forEach((it) => { if (it) add(it.code, it.qty); });
                });
            } else {
                (typeof stockMovementLog !== 'undefined' && Array.isArray(stockMovementLog) ? stockMovementLog : []).forEach((m) => {
                    if (!m || !inWin(dateKey(new Date(m.timestamp)))) return;
                    const d = stockMoveDelta(m);
                    if (kind === 'mvAfter') add(m.code, d);
                    else if (kind === 'mvAdded' ? d > 0 : d < 0) add(m.code, Math.abs(d));
                });
            }
            cache.set(ck, out);
            return out;
        }

//@fn stockMovementDeltaAfter
function stockMovementDeltaAfter(code, dateStr) {
            return stockReportTotals('mvAfter', dateStr).get(code) || 0;
        }

//@fn stockMovementDeltaWithinRange
function stockMovementDeltaWithinRange(code, fromStr, toStr, wantAdded) {
            return stockReportTotals(wantAdded ? 'mvAdded' : 'mvRemoved', fromStr, toStr).get(code) || 0;
        }

//@fn stockReportPeriodLabel
function stockReportPeriodLabel(range) {
            const fmt = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            return range.from === range.to ? fmt(range.from) : `${fmt(range.from)} — ${fmt(range.to)}`;
        }

//@fn stockReportPeriodRange
function stockReportPeriodRange() {
            const activeBtn = document.querySelector('#stock-report-period-filter-bar .item-filter-btn.active');
            const preset = activeBtn ? activeBtn.dataset.period : 'daily';

            if (preset === 'weekly') {
                // Sunday through today (not a rolling 7-day window) — resets each Sunday.
                const today = new Date();
                const from = new Date(today);
                from.setDate(today.getDate() - today.getDay());
                return { preset, from: dateKey(from), to: dateKey(today) };
            }
            if (preset === 'monthly') {
                const monthPicker = document.getElementById('stock-report-month-picker');
                if (monthPicker && !monthPicker.value) monthPicker.value = todayDateString().slice(0, 7);
                const [y, m] = (monthPicker ? monthPicker.value : todayDateString().slice(0, 7)).split('-').map(Number);
                const first = new Date(y, m - 1, 1);
                const last = new Date(y, m, 0);
                return { preset, from: dateKey(first), to: dateKey(last) };
            }
            if (preset === 'custom') {
                const fromEl = document.getElementById('stock-report-date-from');
                const toEl = document.getElementById('stock-report-date-to');
                if (fromEl && !fromEl.value) fromEl.value = todayDateString();
                if (toEl && !toEl.value) toEl.value = fromEl ? fromEl.value : todayDateString();
                const fromVal = fromEl ? fromEl.value : todayDateString();
                const toVal = toEl ? toEl.value : fromVal;
                return fromVal <= toVal ? { preset, from: fromVal, to: toVal } : { preset, from: toVal, to: fromVal };
            }
            const picker = document.getElementById('stock-report-date-picker');
            if (picker && !picker.value) picker.value = todayDateString();
            const dateVal = picker ? picker.value : todayDateString();
            return { preset, from: dateVal, to: dateVal };
        }

//@fn stopBackgroundCameraScan
function stopBackgroundCameraScan() {
            if (cameraScanIntervalId) {
                clearInterval(cameraScanIntervalId);
                cameraScanIntervalId = null;
            }
            if (cameraScanStream) {
                cameraScanStream.getTracks().forEach(track => track.stop());
                cameraScanStream = null;
            }
            cameraScanTrack = null;
            cameraScanCanvas = null;
            cameraScanCanvasCtx = null;
            cameraScanTorchOn = false;
            cameraScanTorchSupported = false;
            renderCameraScanTorchButton();
        }

//@fn stopCamera
function stopCamera() {
            if (videoStream) {
                videoStream.getTracks().forEach(track => track.stop());
                videoStream = null;
            }
        }

//@fn stopInvCellEdit
function stopInvCellEdit(id, field) {
            inventoryEditingCells.delete(invCellKey(id, field));
        }

//@fn submitBarcodeScanManual
function submitBarcodeScanManual() {
            const val = (document.getElementById('barcode-scan-manual-input').value || '').trim();
            if (!val) { showToast('Type a code first.', true); return; }
            completeBarcodeScanModal(val);
        }

//@fn submitDemoPurgeConfirm
function submitDemoPurgeConfirm() {
            const val = (document.getElementById('demo-purge-confirm-input').value || '').trim();
            if (val !== 'CLEAR DEMO DATA') {
                document.getElementById('demo-purge-error').textContent = 'Type it exactly as shown: CLEAR DEMO DATA';
                return;
            }
            document.getElementById('demo-purge-modal').style.display = 'none';
            adminPwModalPurpose = 'purge-demo-data';
            showAdminPwModal(
                'Management Access',
                'Enter the management password to purge demo data and go live',
                'No management password is set yet. Create one now to protect this action.'
            );
        }

//@fn submitPrintRelayJob
async function submitPrintRelayJob(jobType, text) {
            try {
                const res = await fetch(apiUrl('/api/print-relay'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'submit', jobType, text,
                        sourceDeviceId: thisDeviceId,
                        sourceStation: thisDeviceStation,
                    }),
                });
                const data = await res.json().catch(() => ({}));
                return !!(res.ok && data.ok);
            } catch (e) {
                return false;
            }
        }

//@fn supplierOptionsHtml
function supplierOptionsHtml(selectedId) {
            const options = [`<option value="">— No supplier —</option>`]
                .concat([...suppliers].sort((a, b) => a.name.localeCompare(b.name))
                    .map(s => `<option value="${escapeHtml(s.id)}" ${selectedId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`));
            return options.join('');
        }

//@fn switchTab
function switchTab(evt, tabId) {
            performTabSwitch(evt.currentTarget, tabId);
        }

//@fn syncExchangeSplitDefaults
function syncExchangeSplitDefaults(netPayable) {
            const cashInput = document.getElementById('exchange-split-cash-input');
            const mpesaInput = document.getElementById('exchange-split-mpesa-input');
            if (!cashInput.value && !mpesaInput.value) {
                cashInput.value = netPayable.toFixed(2);
                mpesaInput.value = '0.00';
            }
        }

//@fn syncNotificationSettingsUI
function syncNotificationSettingsUI() {
            const statusEl = document.getElementById('stock-notif-status');
            const enableBtn = document.getElementById('stock-notif-enable-btn');
            const disableBtn = document.getElementById('stock-notif-disable-btn');
            if (!statusEl || !enableBtn || !disableBtn) return;

            if (!notificationsSupported()) {
                statusEl.className = 'settings-msg error';
                statusEl.textContent = 'This browser doesn’t support notifications. On iPhone/iPad, install the app to the home screen first (⚙️ Settings → 📱 Install App).';
                enableBtn.style.display = 'none';
                disableBtn.style.display = 'none';
                return;
            }

            if (Notification.permission === 'denied') {
                statusEl.className = 'settings-msg error';
                statusEl.textContent = 'Blocked. Allow notifications for this site in your browser settings, then reload.';
                enableBtn.style.display = 'none';
                disableBtn.style.display = 'none';
                return;
            }

            if (stockNotificationsEnabled && Notification.permission === 'granted') {
                statusEl.className = 'settings-msg success';
                statusEl.textContent = '✅ On for this device.';
                enableBtn.style.display = 'none';
                disableBtn.style.display = 'block';
            } else {
                statusEl.className = 'settings-msg';
                statusEl.textContent = 'Off. Turn them on to be told when stock runs low or items near expiry.';
                enableBtn.style.display = 'block';
                disableBtn.style.display = 'none';
            }
        }

//@fn testPaperCut
async function testPaperCut() {
            const statusEl = document.getElementById('paper-cut-test-status');
            const setStatus = (msg, isError) => {
                if (!statusEl) return;
                statusEl.className = isError ? 'settings-msg error' : 'settings-msg success';
                statusEl.textContent = msg;
            };
            const cutBytes = ESCPOS.concat([ESCPOS.INIT, ESCPOS.FEED3, ESCPOS.CUT]);
            try {
                if (printerMode === 'bluetooth' && btPrinterCharacteristic) {
                    await sendBytesViaBluetooth(cutBytes);
                    setStatus('Cut command sent over Bluetooth.');
                } else if (printerMode === 'usb' && usbPrinterDevice && usbPrinterEndpoint !== null) {
                    await sendBytesViaUSB(cutBytes);
                    setStatus(`Cut command sent over USB (${getPaperCols()}-column formatting active).`);
                } else if (printerMode === 'system') {
                    setStatus('System print dialog mode uses the printer\'s own driver for cutting — there\'s no raw command to test here. Connect via Bluetooth or USB above to test the cutter directly.', true);
                } else {
                    setStatus('No Bluetooth/USB printer connected yet — connect one above first.', true);
                }
            } catch (e) {
                setStatus(`Cut test failed: ${e.message}`, true);
            }
        }

//@fn testPoleDisplay
async function testPoleDisplay() {
            const statusEl = document.getElementById('pole-display-status');
            if (!poleDisplayWriter) {
                statusEl.className = 'settings-msg error';
                statusEl.textContent = 'Not connected yet — tap Connect Pole Display first.';
                return;
            }
            const ok = await sendToPoleDisplay('Hello!', 'KES 0.00');
            statusEl.className = ok ? 'settings-msg success' : 'settings-msg error';
            statusEl.textContent = ok
                ? `Sent in ${poleDisplayMode === 'cd5220' ? 'CD5220/UTC' : 'Epson'} mode — check the display. If it's blank or garbled, switch the mode below and test again.`
                : 'Could not send — it may have disconnected.';
        }

//@fn testPoleDisplayRawInit
async function testPoleDisplayRawInit() {
            const statusEl = document.getElementById('pole-display-raw-msg');
            if (!poleDisplayWriter) {
                statusEl.className = 'settings-msg error';
                statusEl.textContent = 'Not connected yet — tap Connect Pole Display first.';
                return;
            }
            let initBytes;
            try {
                initBytes = parseHexBytes(document.getElementById('pole-display-raw-init-input').value);
            } catch (e) {
                statusEl.className = 'settings-msg error';
                statusEl.textContent = e.message;
                return;
            }
            if (initBytes.length === 0) {
                statusEl.className = 'settings-msg error';
                statusEl.textContent = 'Enter at least one hex byte, e.g. 1B 40.';
                return;
            }
            try {
                const encoder = new TextEncoder();
                const bytes = new Uint8Array([
                    ...initBytes,
                    ...encoder.encode(padPoleLine('Custom Test', 20)),
                    0x0D, 0x0A,
                    ...encoder.encode(padPoleLine('KES 0.00', 20)),
                ]);
                await poleDisplayWriter.write(bytes);
                statusEl.className = 'settings-msg success';
                statusEl.textContent = 'Sent — check the display. If this is the sequence that works, tell me the bytes you used and I’ll add it as a proper preset.';
            } catch (e) {
                statusEl.className = 'settings-msg error';
                statusEl.textContent = 'Could not send — it may have disconnected.';
            }
        }

//@fn textToPdfBlob
function textToPdfBlob(text, opts) {
            const canvas = buildReceiptCanvas(text, opts);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
            const jpegBytes = dataUrlToUint8Array(dataUrl);
            return Promise.resolve(jpegBytesToPdfBlob(jpegBytes, canvas.width, canvas.height));
        }

//@fn textToPngBlob
function textToPngBlob(text, opts) {
            return new Promise((resolve) => {
                buildReceiptCanvas(text, opts).toBlob((blob) => resolve(blob), 'image/png');
            });
        }

//@fn todayLocalDateStr
function todayLocalDateStr() {
            return bizDayKey(Date.now());
        }

//@fn toggleAdhocBorrowedFields
function toggleAdhocBorrowedFields() {
            const checked = document.getElementById('adhoc-sale-borrowed-toggle').checked;
            document.getElementById('adhoc-borrowed-fields').style.display = checked ? 'block' : 'none';
            if (checked) {
                // A sensible starting point — what's owed usually matches the
                // selling price unless there's a markup, so pre-fill it and
                // let the cashier adjust if the two prices actually differ.
                const priceInput = document.getElementById('adhoc-sale-price-input');
                const amountInput = document.getElementById('adhoc-borrowed-amount-input');
                if (!amountInput.value && priceInput.value) amountInput.value = priceInput.value;
            }
        }

//@fn toggleAutoOpenDrawer
function toggleAutoOpenDrawer(checked) {
            autoOpenDrawerEnabled = checked;
            safeSetItem('pos_auto_open_drawer', String(checked));
        }

//@fn toggleBillNotifyStaff
function toggleBillNotifyStaff(staffId, checked) {
            const set = new Set(billNotifyStaffIds);
            if (checked) set.add(staffId); else set.delete(staffId);
            billNotifyStaffIds = [...set];
            safeSetItem('pos_bill_notify_staff_ids', JSON.stringify(billNotifyStaffIds));
            queuePush();
        }

//@fn toggleCameraScanTorch
async function toggleCameraScanTorch() {
            if (!cameraScanTrack || !cameraScanTorchSupported) return;
            try {
                cameraScanTorchOn = !cameraScanTorchOn;
                await cameraScanTrack.applyConstraints({ advanced: [{ torch: cameraScanTorchOn }] });
                renderCameraScanTorchButton();
            } catch (e) {
                cameraScanTorchOn = !cameraScanTorchOn; // revert — the device rejected it
                showToast('Could not control the flash on this device.', true);
            }
        }

//@fn toggleChangePinPanel
function toggleChangePinPanel() {
            const panel = document.getElementById('server-changepin-panel');
            if (!panel) return;
            const showing = panel.style.display !== 'none';
            panel.style.display = showing ? 'none' : 'block';
            if (!showing) {
                ['changepin-current', 'changepin-new', 'changepin-confirm'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.value = '';
                });
                const msg = document.getElementById('changepin-msg');
                if (msg) { msg.className = 'settings-msg'; msg.textContent = ''; }
                setTimeout(() => {
                    const first = document.getElementById('changepin-current');
                    if (first) first.focus();
                }, 50);
            }
        }

//@fn toggleComboBuilder
function toggleComboBuilder() {
            const checked = document.getElementById('inv-is-combo').checked;
            document.getElementById('combo-builder').style.display = checked ? 'block' : 'none';
            if (checked && comboDraft.length === 0) {
                addComboRow();
            } else {
                renderComboRows();
            }
            if (checked) {
                const recipeBox = document.getElementById('inv-has-recipe');
                if (recipeBox && recipeBox.checked) {
                    recipeBox.checked = false;
                    toggleRecipeBuilder();
                }
            }
        }

//@fn toggleFloatingKeyboard
function toggleFloatingKeyboard() {
            const panel = document.getElementById('floating-keyboard-panel');
            const btn = document.getElementById('floating-kb-toggle');
            if (!panel) return;
            const showing = panel.style.display !== 'none';
            panel.style.display = showing ? 'none' : 'block';
            if (btn) btn.classList.toggle('active', !showing);
        }

//@fn toggleInteractivePricing
function toggleInteractivePricing(checked) {
            INTERACTIVE_PRICING_ENABLED = !!checked;
            safeSetItem('pos_interactive_pricing_enabled', String(INTERACTIVE_PRICING_ENABLED));
            queuePush();
            renderItemImageGrid(document.getElementById('sales-search') ? document.getElementById('sales-search').value : '');
            showToast(INTERACTIVE_PRICING_ENABLED
                ? 'Interactive Pricing is on — grid items show a price-picker badge, and search selections open the price picker too.'
                : 'Interactive Pricing is off — items add straight to the cart at retail price.');
        }

//@fn toggleInventorySearchClear
function toggleInventorySearchClear() {
            const inp = document.getElementById('inventory-search-input');
            const btn = document.getElementById('inventory-search-clear');
            if (!inp || !btn) return;
            btn.style.display = inp.value ? 'block' : 'none';
        }

//@fn toggleKitchenTicket
function toggleKitchenTicket(checked) {
            kitchenTicketEnabled = checked;
            safeSetItem('pos_kitchen_ticket_enabled', String(checked));
        }

//@fn toggleNewStaffRole
function toggleNewStaffRole(tabId, checked) {
            if (checked) {
                if (!newStaffSelectedRoles.includes(tabId)) newStaffSelectedRoles.push(tabId);
            } else {
                newStaffSelectedRoles = newStaffSelectedRoles.filter(r => r !== tabId);
            }
        }

//@fn toggleOfferCustomDate
function toggleOfferCustomDate() {
            const isCustom = document.getElementById('offer-duration-select').value === 'custom';
            document.getElementById('offer-custom-date-input').style.display = isCustom ? 'block' : 'none';
        }

//@fn togglePrintRoutingRule
function togglePrintRoutingRule(idx) {
            if (!printRoutingRules[idx]) return;
            printRoutingRules[idx].active = printRoutingRules[idx].active === false ? true : false;
            persistPrintRoutingRules();
            renderPrintRoutingRulesList();
        }

//@fn togglePromoOfferActive
function togglePromoOfferActive(id) {
            const offer = offers.find(o => o.id === id);
            if (!offer) return;
            offer.active = !offer.active;
            saveOffersLocal();
            queuePush();
            renderOffersList();
            if (inventoryEditModalCode) renderItemOffersList(inventoryEditModalCode);
            renderCart();
        }

//@fn toggleReceiptSettingsShared
async function toggleReceiptSettingsShared(checked) {
            if (!myIsMainBranch) { showToast('Only the main branch can change this.', true); return; }
            try {
                const res = await fetch(apiUrl('/api/receipt-settings'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'setUseShared', useShared: checked }),
                });
                const data = await res.json();
                if (!res.ok || data.error) { showToast(data.error || 'Could not update this.', true); return; }
                receiptSettingsUseShared = !!data.useShared;
                if (receiptSettingsUseShared) {
                    // Turning sharing on for the first time: seed the shared
                    // settings with whatever this (main) branch currently has,
                    // so every other branch picks up something sensible right
                    // away instead of starting blank.
                    await pushSharedReceiptSettingsIfNeeded();
                    showToast('All branches will now print with these same receipt settings.');
                } else {
                    showToast('Each branch now keeps its own separate receipt settings again.');
                }
            } catch (e) {
                showToast(netErrText('Could not reach the server'), true);
            }
        }

//@fn toggleReturnReasonOther
function toggleReturnReasonOther() {
            const isOther = document.getElementById('return-reason-select').value === 'Other';
            document.getElementById('return-reason-other-input').style.display = isOther ? 'block' : 'none';
        }

//@fn toggleScanModalTorch
async function toggleScanModalTorch() {
            if (!scanModalTrack || !scanModalTorchSupported) return;
            try {
                scanModalTorchOn = !scanModalTorchOn;
                await scanModalTrack.applyConstraints({ advanced: [{ torch: scanModalTorchOn }] });
                document.getElementById('barcode-scan-torch-btn').textContent = scanModalTorchOn ? '🔦 Flash Off' : '🔦 Flash On';
            } catch (e) {
                scanModalTorchOn = !scanModalTorchOn;
                showToast('Could not control the flash on this device.', true);
            }
        }

//@fn toggleScrollToTopVisibility
function toggleScrollToTopVisibility() {
            const btn = document.getElementById('scroll-to-top-btn');
            if (!btn) return;
            btn.classList.toggle('show', window.scrollY > 400);
        }

//@fn toggleServerDropdown
function toggleServerDropdown(evt) {
            evt.stopPropagation();
            const dropdown = document.getElementById('server-dropdown');
            const pickListWrap = document.getElementById('server-pick-list');
            const pinEntry = document.getElementById('server-pin-entry');
            const logoutBtn = document.getElementById('server-logout-btn');
            const changePinWrap = document.getElementById('server-changepin-wrap');
            // Only a checked-in staff member has a PIN to change; the admin uses the
            // shop password, which is changed from Settings → Security.
            if (changePinWrap) changePinWrap.style.display = currentServer ? 'block' : 'none';
            const changePinPanel = document.getElementById('server-changepin-panel');
            if (changePinPanel) changePinPanel.style.display = 'none';

            if (currentServer) {
                pickListWrap.style.display = 'none';
                pinEntry.style.display = 'none';
                logoutBtn.style.display = 'block';
                logoutBtn.textContent = '🕒 Clock Out';
                logoutBtn.onclick = logoutServer;
            } else {
                // Admin is running the till. They still get a Clock Out, which ends
                // their shift and hands the device back to the login picker.
                pickListWrap.style.display = 'block';
                pinEntry.style.display = 'none';
                logoutBtn.style.display = 'block';
                logoutBtn.textContent = '🕒 Clock Out (Admin)';
                logoutBtn.onclick = logoutAdmin;
                renderServerPickList();
            }
            dropdown.classList.toggle('show');
        }

//@fn toggleStaffRosterDetail
function toggleStaffRosterDetail(id) {
            expandedStaffRosterId = (expandedStaffRosterId === id) ? null : id;
            renderStaffPanel();
        }

//@fn toggleStoreManualForm
function toggleStoreManualForm() {
            const form = document.getElementById('store-manual-form');
            form.style.display = form.style.display === 'none' ? 'block' : 'none';
        }

//@fn toggleTradeCreditManualForm
function toggleTradeCreditManualForm() {
            const form = document.getElementById('trade-credit-manual-form');
            form.style.display = form.style.display === 'none' ? 'block' : 'none';
        }

//@fn toggleUnavailableExchangeForm
function toggleUnavailableExchangeForm() {
            const form = document.getElementById('exchange-unavailable-form');
            if (!form) return;
            form.style.display = form.style.display === 'none' ? 'block' : 'none';
        }

//@fn toggleVariantsBuilder
function toggleVariantsBuilder() {
            const checked = document.getElementById('inv-has-variants').checked;
            document.getElementById('variants-builder').style.display = checked ? 'block' : 'none';
            // Retail Price/Wholesale/Cost above become an optional SHARED
            // DEFAULT once variants are on — set it once here if every
            // variant shares it (e.g. all shoe sizes cost the same), and
            // leave it blank if every variant needs its own (each variant's
            // own field then overrides this one). See saveInventoryItem().
            const priceLabel = document.getElementById('inv-price-label');
            const priceInput = document.getElementById('inv-price');
            if (priceLabel) {
                priceLabel.innerHTML = 'Retail Price (KES) ' + (checked
                    ? '<span style="font-weight:normal; color:#7f8c8d;">— shared default for every variant; leave blank if each variant has its own</span>'
                    : '<span id="inv-price-unit-hint" style="font-weight:normal; color:#7f8c8d;">per piece</span>');
            }
            if (priceInput) priceInput.placeholder = checked ? '0.00 (optional if variants set their own)' : '0.00';
            if (checked) {
                document.getElementById('inv-has-dual-unit').checked = false;
                document.getElementById('dual-unit-builder').style.display = 'none';
                if (variantsDraft.length === 0) {
                    variantsDraft.push({ id: genSaleId(), name: '', code: '', price: '', wholesaleSellingPrice: '', wholesalePrice: '', minimumPrice: '', qty: '', dualUnit: false, unitsPerBox: '', pieceCode: '', piecePrice: '', pieceWholesalePrice: '', pieceQty: '', image: null });
                }
                renderVariantRows();
            } else {
                variantsDraft = [];
            }
        }

//@fn triggerAutoPrintReceipt
function triggerAutoPrintReceipt() {
            if (window.__receiptRelayoutOnly) return;   // zip 144: re-laid out for another paper width — not a new print
            if (autoPrintEnabled) setTimeout(() => printReceipt(), 50);
        }

//@fn triggerAutoPrintReport
function triggerAutoPrintReport() {
            if (autoPrintEnabled) setTimeout(() => doPrintReport(), 50);
        }

//@fn triggerInventoryRowImageUpload
function triggerInventoryRowImageUpload(code) {
            inventoryRowImageEditCode = code;
            document.getElementById('inv-row-image-input').click();
        }

//@fn tryAutoReconnectPoleDisplay
async function tryAutoReconnectPoleDisplay() {
            setupPoleDisplayConnectListener();
            if (!navigator.serial || poleDisplayPort) return;
            try {
                const ports = await navigator.serial.getPorts();
                if (ports.length === 0) return;
                await openPoleDisplayPort(ports[0]);
                const statusEl = document.getElementById('pole-display-status');
                if (statusEl) { statusEl.className = 'settings-msg success'; statusEl.textContent = 'Connected.'; }
            } catch (e) {
                // Left disconnected — Settings still shows "Not connected"
                // and the Connect button works as normal.
            }
        }

//@fn unitLabel
function unitLabel(unit) {
            if (['pcs', 'kg', 'g', 'm', 'cm', 'mm', 'l', 'ml', 'in', 'ft', 'yd', 'lb', 'oz', 'gal'].includes(unit)) return unit;
            return unit || 'pcs';
        }

//@fn unlinkRecoveryEmail
async function unlinkRecoveryEmail() {
            if (!confirm('Unlink your recovery email? You will no longer be able to reset your password by email or sign in on a new device this way.')) return;
            const msgEl = document.getElementById('recovery-link-msg');
            try {
                await fetch(apiUrl('/api/account-recovery'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'unlink' }),
                });
                msgEl.className = 'settings-msg success';
                msgEl.textContent = 'Email unlinked.';
                loadRecoveryStatus();
            } catch (e) {
                msgEl.className = 'settings-msg error';
                msgEl.textContent = netErrText('Could not reach the server');
            }
        }

//@fn unreadBillNotifications
function unreadBillNotifications() {
            const viewer = currentNotifViewerId();
            return billNotifications
                .filter(n => isBillNotifRelevant(n) && !(n.readBy || []).includes(viewer))
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        }

//@fn updateAttendanceRosterExpectedTime
function updateAttendanceRosterExpectedTime(id, field, value) {
            const person = attendanceRoster.find(r => r.id === id);
            if (!person) return;
            person[field] = value || '';
            saveAttendanceLocal();
            queuePush();
            showToast(`Expected ${field === 'expectedClockIn' ? 'clock-in' : 'clock-out'} time for "${person.name}" updated.`);
        }

//@fn updateBarcodeCopies
function updateBarcodeCopies(id, value) {
            const entry = savedBarcodes.find(b => b.id === id);
            if (!entry) return;
            entry.copies = Math.max(1, parseInt(value, 10) || 1);
            safeSetItem('pos_barcodes', JSON.stringify(savedBarcodes));
            queuePush();
        }

//@fn updateBillReminderDays
function updateBillReminderDays(value) {
            const n = parseInt(value, 10);
            billReminderDaysBefore = (isNaN(n) || n < 0) ? 3 : n;
            safeSetItem('pos_bill_reminder_days', String(billReminderDaysBefore));
            const el = document.getElementById('bill-reminder-days-input');
            if (el) el.value = billReminderDaysBefore;
            queuePush();
            showToast('Saved.');
        }

//@fn updateBizImportDebtField
function updateBizImportDebtField(id, field, value) {
            const d = bizImportReviewState.debtRows.find(x => x.id === id);
            if (!d) return;
            d[field] = field === 'checked' ? value : (field === 'name' ? value : parseFloat(value) || 0);
        }

//@fn updateBizImportStockField
function updateBizImportStockField(id, field, value) {
            const it = bizImportReviewState.stockItems.find(x => x.id === id);
            if (!it) return;
            it[field] = field === 'checked' ? value : (field === 'name' || field === 'sku' ? value : parseFloat(value) || 0);
        }

//@fn updateBroadcastCharCount
function updateBroadcastCharCount() {
            const text = document.getElementById('broadcast-message-input').value;
            const segments = Math.max(1, Math.ceil(text.length / 160));
            document.getElementById('broadcast-char-count').textContent = `${text.length} characters — ${segments} SMS segment${segments === 1 ? '' : 's'} per recipient`;
        }

//@fn updateCameraScanStatusText
function updateCameraScanStatusText() {
            setCameraScanStatus(cameraScanTorchSupported
                ? 'Active — running in the background, nothing shown on screen. Flash available below.'
                : 'Active — running in the background, nothing shown on screen.');
        }

//@fn updateComboRowCode
function updateComboRowCode(idx, code) {
            comboDraft[idx].code = code;
        }

//@fn updateComboRowCustomName
function updateComboRowCustomName(idx, value) {
            comboDraft[idx].customName = value;
        }

//@fn updateComboRowQty
function updateComboRowQty(idx, value) {
            comboDraft[idx].qty = value;
        }

//@fn updateContractRowField
function updateContractRowField(rowId, field, value) {
            const row = contractDraft.find(r => r.rowId === rowId);
            if (!row) return;
            row[field] = value;
            renderContractTotals();
        }

//@fn updateDeliveriesBadge
function updateDeliveriesBadge() {
            const badge = document.getElementById('deliveries-notif-badge');
            if (!badge) return;
            const relevant = currentServer
                ? deliveryNotifications.filter(n => !n.read && n.agentKey === currentServer.id)
                : deliveryNotifications.filter(n => !n.read);
            badge.textContent = String(relevant.length);
            badge.style.display = relevant.length > 0 ? 'inline-block' : 'none';
        }

//@fn updateDeliveryZone
function updateDeliveryZone(id, field, value) {
            const zone = deliveryZones.find(z => z.id === id);
            if (!zone) return;
            if (field === 'name') {
                const name = value.trim();
                if (!name) { showToast('Zone name can’t be blank.', true); renderDeliveryZonesList(); return; }
                zone.name = name;
            } else if (field === 'fee') {
                const fee = parseFloat(value);
                if (isNaN(fee) || fee < 0) { showToast('Enter a valid fee.', true); renderDeliveryZonesList(); return; }
                zone.fee = fee;
            } else if (field === 'opCost') {
                const opCost = parseFloat(value);
                if (isNaN(opCost) || opCost < 0) { showToast('Enter a valid standard cost.', true); renderDeliveryZonesList(); return; }
                zone.opCost = opCost;
            }
            queuePush();
            renderDeliveryZonesList();
        }

//@fn updateExchangeLinePrice
function updateExchangeLinePrice(code, value) {
            const line = exchangeReplacementItems.find(l => l.code === code);
            if (!line) return;
            const price = parseFloat(value);
            line.price = (isNaN(price) || price < 0) ? 0 : price;
            renderExchangeBalance();
        }

//@fn updateExchangeLineQty
function updateExchangeLineQty(code, value) {
            const line = exchangeReplacementItems.find(l => l.code === code);
            if (!line) return;
            const qty = parseFloat(value);
            line.qty = (!qty || qty <= 0) ? 1 : qty;
            renderExchangeItemsTable();
            renderExchangeBalance();
        }

//@fn updateGasTabVisibility
function updateGasTabVisibility() {
            const btn = document.getElementById('gas-tab-btn');
            if (!btn) return;
            btn.style.display = doGasRefills ? '' : 'none';
            if (!doGasRefills && document.getElementById('gas-tab') && document.getElementById('gas-tab').classList.contains('active')) {
                goToFirstAllowedTab(); // zip 143: not the Sales Counter unless this person was given it
            }
            if (doGasRefills) renderGasTab();
        }

//@fn updateLicenseLockHintText
function updateLicenseLockHintText() {
            const hintEl = document.querySelector('.license-lock-hint');
            if (hintEl) {
                hintEl.innerHTML = `To keep using this, send <strong>KES ${Number(cachedUpgradePrice).toLocaleString('en-KE')}</strong> via M-Pesa to <strong>${escapeHtml(cachedUpgradePhone)}</strong>, then tap the button below.`;
            }
            const altEl = document.getElementById('license-lock-alt-payment');
            if (altEl) {
                altEl.innerHTML = cachedAltPaymentMethods.length === 0 ? '' : `
                    <details style="margin:10px 0; font-size:13px; color:#95a5a6;">
                        <summary style="cursor:pointer; font-weight:600;">Other ways to pay</summary>
                        <div style="margin-top:8px;">
                            ${cachedAltPaymentMethods.map(m => `
                                <div style="margin-bottom:10px;">
                                    <div style="font-weight:600; color:#5b6b60;">${escapeHtml(m.label)}</div>
                                    ${m.type === 'photo'
                                        ? `<img src="${m.photoDataUrl}" style="max-width:200px; margin-top:4px; border-radius:4px;">`
                                        : `<div>${escapeHtml(m.details || '')}</div>`}
                                </div>`).join('')}
                        </div>
                    </details>`;
            }
        }

//@fn updateLocReservationField
function updateLocReservationField(kind, label, field, value) {
            const map = kind === 'table' ? tableStates : roomStates;
            if (!map[label]) map[label] = { status: 'reserved', reservation: {} };
            if (!map[label].reservation) map[label].reservation = {};
            map[label].reservation[field] = field === 'partySize' ? (parseInt(value, 10) || '') : value;
            safeSetItem(kind === 'table' ? 'pos_table_states' : 'pos_room_states', JSON.stringify(map));
            queuePush();
            // Deliberately no re-render here — these fields are edited one
            // keystroke at a time on blur, and a full re-render would be overkill
            // for a single field (the pill/badge on this card doesn't change).
        }

//@fn updateLowStockDescText
function updateLowStockDescText() {
            const descEl = document.getElementById('low-stock-desc-count');
            if (descEl) descEl.innerText = LOW_STOCK_THRESHOLD;
            const headerEl = document.querySelector('.notif-dropdown-header');
            if (headerEl) headerEl.innerText = `⚠️ Low Stock Alerts (≤ ${LOW_STOCK_THRESHOLD} units)`;
        }

//@fn updateLoyaltyTier
function updateLoyaltyTier(id, field, value) {
            const tier = loyaltyTiers.find(t => t.id === id);
            if (!tier) return;
            if (field === 'maxSpend') {
                tier[field] = value.trim() === '' ? null : parseFloat(value) || 0;
            } else {
                tier[field] = parseFloat(value) || 0;
            }
        }

//@fn updateMobileCartFab
function updateMobileCartFab() {
            const btn = document.getElementById('mobile-cart-fab');
            if (!btn) return;
            const salesTab = document.getElementById('sales-tab');
            const onSalesTab = salesTab && salesTab.classList.contains('active');
            const itemCount = Object.values(currentCart || {}).reduce((sum, l) => sum + (l.qty || 0), 0);
            btn.classList.toggle('show', onSalesTab && itemCount > 0);
            const badge = document.getElementById('mobile-cart-fab-badge');
            if (badge) badge.textContent = itemCount > 99 ? '99+' : String(itemCount);
        }

//@fn updateOwnerName
function updateOwnerName(value) {
            ownerName = (value || '').trim();
            safeSetItem('pos_owner_name', ownerName);
            updateServerBtnLabel();
            queuePush();
            showToast('Owner name updated.');
        }

//@fn updatePrintRelayPolling
function updatePrintRelayPolling() {
            const shouldPoll = printRelayServerEnabled && printRelayHasRealPrinter();
            if (shouldPoll && !printRelayPollInterval) {
                printRelayPollInterval = setInterval(pollPrintRelayJobs, 4000);
                pollPrintRelayJobs();
            } else if (!shouldPoll && printRelayPollInterval) {
                clearInterval(printRelayPollInterval);
                printRelayPollInterval = null;
            }
        }

//@fn updatePrintRelaySectionVisibility
function updatePrintRelaySectionVisibility() {
            const section = document.getElementById('print-relay-server-section');
            if (!section) return;
            const hasPrinter = printRelayHasRealPrinter();
            const wantsPrinter = printerMode === 'bluetooth' || printerMode === 'usb';
            section.style.display = (hasPrinter || wantsPrinter) ? 'block' : 'none';
            if (!wantsPrinter && printRelayServerEnabled) {
                // Switched to the system print dialog: there is no raw printer here to print an incoming job on, so the relay goes off.
                printRelayServerEnabled = false;
                safeSetItem('pos_print_relay_server', 'false');
            }
            // A printer that is merely switched off / out of range does NOT switch the relay off (it used to, and stayed off after the power
            // came back until someone found the toggle again). The choice stays; polling pauses while there is no printer and resumes by itself.
            const toggle = document.getElementById('print-relay-server-toggle');
            if (toggle) toggle.checked = printRelayServerEnabled;
            updatePrintRelayPolling();
            heartbeatDeviceNetwork();
        }

//@fn updateRecipeCaptureDish
function updateRecipeCaptureDish(dishId, field, value) {
            const dish = recipeCaptureState.dishes.find(d => d.id === dishId);
            if (dish) dish[field] = value;
        }

//@fn updateRecipeCaptureIngredient
function updateRecipeCaptureIngredient(dishId, ingId, field, value) {
            const dish = recipeCaptureState.dishes.find(d => d.id === dishId);
            const ing = dish && dish.ingredients.find(i => i.id === ingId);
            if (ing) ing[field] = value;
        }

//@fn updateRecipeCaptureIngredientMatch
function updateRecipeCaptureIngredientMatch(dishId, ingId, value) {
            const dish = recipeCaptureState.dishes.find(d => d.id === dishId);
            const ing = dish && dish.ingredients.find(i => i.id === ingId);
            if (!ing) return;
            ing.matchedCode = value || null;
            ing.isNew = !value;
            if (value) {
                const matched = inventory.find(p => p.code === value);
                if (matched) { ing.name = matched.name; ing.unit = matched.unit || ing.unit; }
            }
            flagWithinImportIngredientDuplicates();
            renderRecipeCaptureReview();
        }

//@fn updateRecipeRowIngredient
function updateRecipeRowIngredient(idx, code) {
            recipeDraft[idx].code = code;
            renderRecipeRows();
        }

//@fn updateRecipeRowQty
function updateRecipeRowQty(idx, value) {
            recipeDraft[idx].qtyPerUnit = value;
            // Update the "= 0.5" hint in place. Re-rendering the whole row here would
            // steal focus and drop the cursor mid-keystroke.
            const hintEl = document.querySelector(`.recipe-qty-hint[data-idx="${idx}"]`);
            if (hintEl) {
                const ing = inventory.find(p => p.code === recipeDraft[idx].code);
                const unit = ing ? (ing.unit || 'pcs') : '';
                const hint = qtyInputHint(value, unit);
                hintEl.textContent = (hint && hint !== String(value).trim()) ? `= ${hint}` : '';
            }
            updateRecipeSummary();
        }

//@fn updateRecipeSummary
function updateRecipeSummary() {
            const costEl = document.getElementById('recipe-cost-preview');
            const yieldEl = document.getElementById('recipe-yield-preview');
            if (!costEl || !yieldEl) return;

            let cost = 0;
            let maxYield = Infinity;
            let valid = recipeDraft.length > 0;

            recipeDraft.forEach(row => {
                const ing = inventory.find(p => p.code === row.code);
                const qty = parseQtyInput(row.qtyPerUnit);
                if (!ing || isNaN(qty) || qty <= 0) { valid = false; return; }
                cost += qty * (ing.wholesalePrice || 0);
                const possible = Math.floor(((ing.qty || 0) / qty) + 1e-9);
                if (possible < maxYield) maxYield = possible;
            });

            if (!valid) {
                costEl.textContent = '—';
                yieldEl.textContent = '—';
                return;
            }
            costEl.textContent = `KES ${cost.toFixed(2)}`;
            yieldEl.textContent = `${maxYield}`;
        }

//@fn updateRestockRowField
function updateRestockRowField(rowId, field, value) {
            const row = restockDraft.find(r => r.rowId === rowId);
            if (!row) return;
            row[field] = value;
            renderRestockTotals();
        }

//@fn updateServerBtnLabel
function updateServerBtnLabel() {
            const btn = document.getElementById('server-btn');
            if (!btn) return;
            if (currentServer) {
                btn.innerText = `👤 ${currentServer.name} ▾`;
            } else if (ownerName) {
                // Raw/default state: nobody has checked in via PIN, so the owner
                // themselves is implicitly the one running the till.
                btn.innerText = `👑 ${ownerName} ▾`;
            } else {
                btn.innerText = '👤 Not Serving ▾';
            }
        }

//@fn updateVariantRow
function updateVariantRow(id, field, value) {
            const row = variantsDraft.find(v => v.id === id);
            if (row) row[field] = value;
        }

//@fn updateVariantsModalField
function updateVariantsModalField(id, field, value) {
            const row = variantsModalDraft.find(v => v.id === id);
            if (row) row[field] = value;
        }

//@fn verifyBiometric
async function verifyBiometric(eligibleRoles) {
            const creds = (await listWebAuthnCredentials()).filter(c => eligibleRoles.includes(c.role));
            if (creds.length === 0) return null;
            try {
                const challenge = crypto.getRandomValues(new Uint8Array(32));
                const assertion = await navigator.credentials.get({
                    publicKey: {
                        challenge,
                        allowCredentials: creds.map(c => ({ id: base64urlDecode(c.credentialId), type: 'public-key' })),
                        userVerification: 'required',
                        timeout: 60000,
                    },
                });
                if (!assertion) return null;
                const matchedId = base64urlEncode(assertion.rawId);
                return creds.find(c => c.credentialId === matchedId) || null;
            } catch (e) {
                return null;
            }
        }

//@fn verifyManagerPin
async function verifyManagerPin() {
            const errorEl = document.getElementById('admin-pw-error');
            const select = document.getElementById('manager-pin-select');
            const input = document.getElementById('manager-pin-input');
            const manager = staff.find(s => s.id === select.value && s.isManager);
            if (!manager) {
                errorEl.textContent = 'Select a manager.';
                return null;
            }
            const enteredHash = await hashPassword(input.value);
            if (!(await hashMatches(enteredHash, manager.pinHash))) {
                errorEl.textContent = 'Incorrect PIN.';
                input.value = '';
                input.focus();
                return null;
            }
            return manager;
        }

//@fn warnAboutCorruptedStorageIfNeeded
function warnAboutCorruptedStorageIfNeeded() {
            if (corruptedStorageKeys.length === 0 && recoveredStorageKeys.length === 0) return;
            if (recoveredStorageKeys.length > 0) {
                console.warn('Recovered corrupted local data from its own backup for:', recoveredStorageKeys.join(', '));
            }
            if (corruptedStorageKeys.length > 0) {
                console.error('Reset corrupted local data on load for:', corruptedStorageKeys.join(', '));
            }
            const parts = [];
            if (recoveredStorageKeys.length > 0) parts.push(`${recoveredStorageKeys.length} item${recoveredStorageKeys.length === 1 ? '' : 's'} recovered from a local backup`);
            if (corruptedStorageKeys.length > 0) parts.push(`${corruptedStorageKeys.length} item${corruptedStorageKeys.length === 1 ? '' : 's'} reset to blank (no backup available)`);
            showToast(`Some locally stored data needed repair on load — ${parts.join(', ')}. Check Settings → Backups if anything looks off.`, true);
        }

//@fn workbookToTextDocument
function workbookToTextDocument(workbook) {
            const lines = [];
            workbook.SheetNames.forEach(sn => {
                const rows = gridRowsFromSheet(workbook.Sheets[sn]);
                rows.forEach(r => {
                    const cells = r.map(c => String(c == null ? '' : c).trim());
                    if (cells.every(c => c === '')) return;
                    lines.push(cells.join(' | '));
                });
            });
            return lines.slice(0, 400).join('\n').slice(0, 110000);
        }

//@fn watchUsbPrinterDisconnect
function watchUsbPrinterDisconnect() {
            // WebUSB reports unplug/replug on navigator.usb - NOT on the USBDevice itself, which is
            // not an EventTarget. The old code called device.addEventListener(...), which threw
            // "device.addEventListener is not a function" right AFTER the printer had connected, so
            // a working connection was reported as a failure. Hooked once per page.
            if (!navigator.usb || window.__usbPrinterWatch) return;
            window.__usbPrinterWatch = true;
            const same = (a, b) => a === b || (a && b && a.vendorId === b.vendorId
                && a.productId === b.productId && a.serialNumber === b.serialNumber);
            navigator.usb.addEventListener('disconnect', (e) => {
                if (!usbPrinterDevice || !same(e.device, usbPrinterDevice)) return;
                usbPrinterDevice = null;
                usbPrinterEndpoint = null;
                const el = document.getElementById('usb-printer-status');
                if (el) { el.className = 'settings-msg error'; el.textContent = 'Printer unplugged. Plug it back in and it will reconnect on its own.'; }
                if (typeof updatePrintRelaySectionVisibility === 'function') updatePrintRelaySectionVisibility();
            });
            navigator.usb.addEventListener('connect', () => {
                // Plugged back in: silently re-open the already-permitted printer (USB mode only).
                if (typeof autoReconnectUsbPrinter === 'function') autoReconnectUsbPrinter();
            });
        }

//@fn thermalAscii
function thermalAscii(str) {
            // Thermal printers read single-byte code pages, NOT UTF-8. Sending "—", "’" or "é" as
            // UTF-8 made them print as 2-3 junk characters ("â€”"), which is a big part of why
            // receipts looked unclear. Map the common ones to plain equivalents, strip accents,
            // and drop anything the printer can't draw (emoji etc.) instead of printing junk.
            return String(str)
                .replace(/[\u2013\u2014\u2212]/g, '-')
                .replace(/[\u2018\u2019\u201B\u2032\u00B4`]/g, "'")
                .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
                .replace(/\u2026/g, '...')
                .replace(/[\u00D7\u2715\u2716]/g, 'x')
                .replace(/[\u2022\u25CF\u00B7]/g, '*')
                .replace(/\u2192/g, '->').replace(/\u2190/g, '<-')
                .replace(/\u20AC/g, 'EUR').replace(/\u00A3/g, 'GBP')
                .replace(/[\u00A0\u2007\u202F]/g, ' ')
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[^\x20-\x7E\t]/g, '');
        }

//@fn thermalWrapLine
function thermalWrapLine(line, cols) {
            // Wrap at word boundaries so the PRINTER never has to break a line mid-word.
            line = line.replace(/\s+$/, '');
            if (line.length <= cols) return [line];
            // A column-aligned line (fields separated by 2+ spaces) that is too wide is SQUEEZED — the widest gaps shrink first, down
            // to one space — so its fields stay whole and the last one stays on the right edge. (Was: only when at most 6 too wide;
            // a line laid out for wider paper then fell through to plain wrapping and split its numbers across lines.) (zip 144)
            if (/\S {2,}\S/.test(line)) {
                let over = line.length - cols;
                const parts = line.split(/( {2,})/);
                while (over > 0) {
                    let idx = -1, best = 1;
                    parts.forEach((p, i) => { if (/^ {2,}$/.test(p) && i > 0 && p.length > best) { best = p.length; idx = i; } });
                    if (idx === -1) break;
                    parts[idx] = parts[idx].slice(1);
                    over--;
                }
                const squeezed = parts.join('');
                if (squeezed.length <= cols) return [squeezed];
            }
            const lead = Math.min((line.match(/^ */)[0]).length, Math.floor(cols / 2));
            const indent = ' '.repeat(lead);
            const room = cols - lead;
            const out = [];
            let cur = '';
            // Words; a currency and its amount ("KES 350.00", "-KES 50.00") are one word — never "KES" at the end of a line and the
            // amount on the next.
            const words = [];
            line.trim().split(/ +/).forEach((w) => {
                const prev = words[words.length - 1];
                if (prev && /^-?(KES|KSH|Ksh|Kshs)$/.test(prev) && /^-?[\d.,]+/.test(w)) words[words.length - 1] = prev + ' ' + w;
                else words.push(w);
            });
            words.forEach((word) => {
                while (word.length > room) {                       // a single token longer than the paper (a long reference)
                    if (cur) { out.push(cur); cur = ''; }
                    out.push(indent + word.slice(0, room));
                    word = word.slice(room);
                }
                if (!cur) cur = indent + word;
                else if ((cur + ' ' + word).length <= cols) cur += ' ' + word;
                else { out.push(cur); cur = indent + word; }
            });
            if (cur) out.push(cur);
            return out;
        }

//@fn thermalFitLegacyWidth
function thermalFitLegacyWidth(line, cols) {
            // Several apps were built before paper-width support and lay every receipt line out for
            // exactly 32 columns. On 80mm paper (48 columns) that squeezed the whole receipt into
            // the left two-thirds. Stretch those 32-wide lines to the real width: rules become full
            // width, right-aligned lines go to the right edge, and "LABEL ...... value" lines push
            // the value to the right edge. Lines of any other length are left alone.
            if (cols === 32 || line.length !== 32) return line;
            if (/^-+$/.test(line)) return '-'.repeat(cols);
            if (/^ +\S/.test(line)) return line.trim().padStart(cols);
            const m = line.match(/^(.*\S) {2,}(\S+(?: \S+)*)$/);
            if (m) return m[1] + ' '.repeat(Math.max(1, cols - m[1].length - m[2].length)) + m[2];
            return line;
        }

//@fn thermalPrepareText
function thermalPrepareText(text) {
            const cols = (typeof getPaperCols === 'function') ? getPaperCols() : 32;
            const out = [];
            String(text).replace(/\r/g, '').split('\n').forEach((raw) => {
                const fitted = thermalFitLegacyWidth(thermalAscii(raw), cols);
                thermalWrapLine(fitted, cols).forEach((l) => out.push(l));
            });
            return out.join('\n');
        }

//@fn thermalLayout
function thermalLayout(cols) {
            // Fixed widths for the numeric columns; the item name gets whatever is left.
            if (cols >= 44) return { qty: 7, price: 10, amt: 12 };
            if (cols >= 38) return { qty: 6, price: 9, amt: 11 };
            return { qty: 6, price: 8, amt: 10 };
        }

//@fn thermalItemHeader
function thermalItemHeader(cols) {
            // The column header row for raw (USB / Bluetooth) receipts. Until now only the on-screen
            // and system-dialog receipts had column headings.
            const L = thermalLayout(cols);
            const nameW = cols - (L.qty + L.price + L.amt);
            return [
                'ITEM'.padEnd(nameW) + 'QTY'.padStart(L.qty) + 'PRICE'.padStart(L.price) + 'AMOUNT'.padStart(L.amt),
                '-'.repeat(cols),
            ];
        }

//@fn thermalItemRow
function thermalItemRow(cols, name, code, qtyStr, priceStr, amountStr, tag) {
            // One item as a real table row under the header: the name (wrapped, never cut), then a
            // numbers line with QTY / PRICE / AMOUNT right-aligned to the header's columns. The
            // item code sits on the left of the numbers line, and the VAT class letter follows the
            // amount. If the numbers are too wide for the columns they are stacked instead.
            const L = thermalLayout(cols);
            const nameW = cols - (L.qty + L.price + L.amt);
            const amt = tag ? amountStr + ' ' + tag : amountStr;
            const out = thermalWrapLine(String(name), cols).slice();
            const codeStr = code ? '#' + code : '';
            if (qtyStr.length < L.qty && priceStr.length < L.price && amt.length <= L.amt) {
                const left = codeStr.length <= nameW - 1 ? codeStr : '';
                if (codeStr && !left) out.push(codeStr);
                out.push(left.padEnd(nameW) + qtyStr.padStart(L.qty) + priceStr.padStart(L.price) + amt.padStart(L.amt));
            } else {
                if (codeStr) out.push(codeStr);
                out.push((qtyStr + ' x ' + priceStr).padStart(cols));
                out.push(amt.padStart(cols));
            }
            return out;
        }

//@fn thermalVatHeader
function thermalVatHeader(cols) {
            // The standard header is 33 characters - one more than a 58mm roll holds, so the last
            // letter wrapped onto its own line. Compact form for narrow paper.
            if (cols >= 34) { const vw = Math.floor((cols - 12) / 2); return 'CODE'.padEnd(6) + 'RATE'.padEnd(6) + 'VATABLE AMT'.padStart(cols - 12 - vw) + 'VAT AMT'.padStart(vw); }   // amounts on the right edge (zip 144)
            return 'CODE'.padEnd(5) + 'RATE'.padEnd(5) + 'VATABLE'.padStart(12) + 'VAT'.padStart(10);
        }

//@fn thermalVatRow
function thermalVatRow(cat, g, cols) {
            if (cols >= 34) { const vw = Math.floor((cols - 12) / 2); return cat.padEnd(6) + `${g.rate}%`.padEnd(6) + g.net.toFixed(2).padStart(cols - 12 - vw) + g.vat.toFixed(2).padStart(vw); }
            return cat.padEnd(5) + `${g.rate}%`.padEnd(5) + g.net.toFixed(2).padStart(12) + g.vat.toFixed(2).padStart(10);
        }

//@fn receiptSectionsFor
function receiptSectionsFor(text) {
            // The receipt is built as three sections (header / items / footer). Returns them when
            // `text` is exactly that receipt, so the raw printer path can centre and bold the
            // header and footer instead of printing the whole thing as one left-aligned block.
            try {
                if (lastReceiptHeader && lastReceiptItemSection
                    && [lastReceiptHeader, lastReceiptItemSection, lastReceiptFooter].join('\n') === text) {
                    return { header: lastReceiptHeader, items: lastReceiptItemSection, footer: lastReceiptFooter };
                }
            } catch (e) { /* this app doesn't keep the sections */ }
            return null;
        }

//@fn buildSectionedReceiptBytes
function buildSectionedReceiptBytes(headerText, itemsText, footerText, cutBytes) {
            // ESC/POS bytes for a receipt whose header and footer print centred (business name bold),
            // the item table follows the alignment setting, and the column-header and TOTAL rows are bold.
            const enc = new TextEncoder();
            const b = (arr) => new Uint8Array(arr);
            const concat = (chunks) => {
                const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
                let o = 0;
                chunks.forEach((c) => { out.set(c, o); o += c.length; });
                return out;
            };
            const line = (s) => enc.encode(thermalPrepareText(s) + '\n');
            const boldLine = (s) => concat([b([0x1B, 0x45, 1]), line(s), b([0x1B, 0x45, 0])]);
            const just = (n) => b([0x1B, 0x61, n]);
            const itemAlign = receiptItemAlign === 'center' ? 1 : receiptItemAlign === 'right' ? 2 : 0;
            const refBarcode = receiptRefBarcodeBytes(footerText);
            return concat([
                b([0x1B, 0x40, 0x1B, 0x4D, 0x00]),                                   // initialise + font A
                just(1), ...String(headerText).split('\n').map((l, i) => (i === 0 ? boldLine(l) : line(l))),
                just(itemAlign), ...String(itemsText).split('\n').map((l) => (/^\s*(TOTAL|AMOUNT DUE TODAY|DUE NOW|ITEM\s+QTY)\b/.test(l) ? boldLine(l) : line(l))),
                just(1), line(footerText),
                ...(refBarcode ? [line(''), refBarcode] : []),                        // scannable reference barcode (image)
                b([0x1B, 0x64, 0x03]),                                                // feed
                // GS V B 0: feed to the cutter, THEN partial-cut. A plain "GS V 0" cuts where the print head is and
                // can slice through the last printed line — which is the Ref number.
                cutBytes || b([0x1D, 0x56, 0x42, 0x00]),
            ]);
        }

//@fn usbPrinterNameKey
function usbPrinterNameKey() { return 'pos_usb_printer_name'; }

//@fn claimUsbPrinterEndpoint
function claimUsbPrinterEndpoint(device, statusEl) {
            // One claim per device at a time (the printer keeper, the "plugged in" event and the Connect button can all ask at once).
            if (window.__hwClaim && window.__hwClaim.device === device) return window.__hwClaim.promise;
            const promise = claimUsbPrinterEndpointOnce(device, statusEl).finally(() => { if (window.__hwClaim && window.__hwClaim.device === device) window.__hwClaim = null; });
            window.__hwClaim = { device, promise };
            return promise;
        }

//@fn claimUsbPrinterEndpointOnce
async function claimUsbPrinterEndpointOnce(device, statusEl) {
            // Opens the device, finds the endpoint the print engine actually listens on, and claims it.
            try { await device.open(); } catch (e) { if (!device.opened) throw e; }   // already open is fine
            if (!device.configuration) await device.selectConfiguration(1);

            // Every OUT endpoint on the device, best first. Many USB printers are COMPOSITE devices (a printer
            // interface plus a keyboard/HID, card reader or vendor interface). The old code took the first
            // interface that had any OUT endpoint, which on those units was the HID one: the job was "sent"
            // successfully and nothing ever printed. Prefer the printer class (7), then vendor-specific (255),
            // and only BULK endpoints (an interrupt OUT endpoint never reaches the print engine).
            const candidates = [];
            for (const iface of device.configuration.interfaces) {
                for (const alt of iface.alternates) {
                    const cls = alt.interfaceClass;
                    const rank = cls === 7 ? 0 : cls === 255 ? 1 : (cls === 3 || cls === 8) ? 30 : 2;
                    alt.endpoints.filter((e) => e.direction === 'out').forEach((ep) => {
                        candidates.push({ iface: iface.interfaceNumber, alt: alt.alternateSetting || 0, ep: ep.endpointNumber, rank: rank + (ep.type === 'bulk' || !ep.type ? 0 : 10) });
                    });
                }
            }
            candidates.sort((a, b) => a.rank - b.rank);

            if (candidates.length === 0) {
                if (statusEl) {
                    statusEl.className = 'settings-msg error';
                    statusEl.textContent = `Connected to ${device.productName || 'printer'}, but couldn’t find a usable USB endpoint on it. Try "System print dialog" instead.`;
                }
                await device.close();
                return false;
            }

            // Claim the best interface; if the OS driver holds it, try the next one before giving up.
            let chosen = null, lastError = null;
            const tried = new Set();
            for (const c of candidates) {
                if (tried.has(c.iface)) continue;
                tried.add(c.iface);
                try {
                    await device.claimInterface(c.iface);
                    if (c.alt) await device.selectAlternateInterface(c.iface, c.alt);
                    chosen = c;
                    break;
                } catch (e) { lastError = e; }
            }
            if (!chosen) throw lastError || new Error('Could not claim any interface on this printer.');

            usbPrinterDevice = device;
            usbPrinterEndpoint = chosen.ep;
            safeSetItem(usbPrinterNameKey(), device.productName || 'USB printer');
            safeSetItem(hwKey('usb_printer_id'), [device.vendorId, device.productId, device.serialNumber || ''].join(':'));

            watchUsbPrinterDisconnect();

            if (statusEl) {
                statusEl.className = 'settings-msg success';
                statusEl.textContent = `Connected: ${device.productName || 'USB printer'}`;
            }
            if (typeof updatePrintRelaySectionVisibility === 'function') updatePrintRelaySectionVisibility();
            return true;
        }

//@fn sendBytesViaUSB
async function sendBytesViaUSB(bytes) {
            // Bulk-transfers the bytes to the printer. Some printers have a small input buffer and reject a big
            // write with a NetworkError: that data is retried in smaller pieces (512, then 64 bytes) rather than
            // failing the whole receipt. A stalled endpoint is cleared and retried.
            let chunk = 4096, stalls = 0;
            for (let i = 0; i < bytes.length;) {
                const part = bytes.slice(i, i + chunk);
                try {
                    const res = await hwWithTimeout(usbPrinterDevice.transferOut(usbPrinterEndpoint, part));
                    if (res && res.status === 'stall') {
                        if (++stalls > 3) throw new Error('The printer stopped responding. Switch it off and on, then reconnect it.');
                        await usbPrinterDevice.clearHalt('out', usbPrinterEndpoint);
                        continue;
                    }
                    i += (res && res.bytesWritten > 0) ? Math.min(res.bytesWritten, part.length) : part.length;
                } catch (e) {
                    if (e && e.name === 'NetworkError' && chunk > 64) { chunk = chunk > 512 ? 512 : 64; continue; }
                    if (e && e.name === 'NotFoundError') { usbPrinterDevice = null; usbPrinterEndpoint = null; }   // unplugged mid-job
                    try { e.hwWritten = i; } catch (e2) { /* read-only error object */ }                            // how much had already gone out (see hwWrapPrinting)
                    throw e;
                }
            }
        }


//@fn receiptPaymentDetailsList
function receiptPaymentDetailsList() {
            // The shop's Paybill/Till/phone lines (Settings > Receipt). Apps name the setting differently.
            const raw = (typeof paymentDetails === 'string' && paymentDetails) ? paymentDetails
                : (typeof billPaymentDetails === 'string' ? billPaymentDetails : '');
            return String(raw || '').split('\n').map(s => s.trim()).filter(Boolean);
        }

//@fn buildReceiptDoc
function buildReceiptDoc(sale, hooks) {
            // ONE receipt layout for every app (Shop's layout is the default). The on-screen preview, the
            // system print dialog, USB and Bluetooth are all built from the SAME rows/lines here, so they
            // cannot drift apart. Per-app differences are passed in as optional `hooks`:
            //   defaultName, total(sale,sum), docLabel(sale,ctx), headerExtra(sale), itemCells(l,sale),
            //   itemSubLines(l,sale), afterItems(sale,ctx), totalLabel(sale), paymentLines(sale,ctx),
            //   footerNotes(sale), autoPrint
            hooks = hooks || {};
            const cols = getPaperCols();
            const rule = '-'.repeat(cols);
            const labelCol = Math.max(10, cols - 12);   // room for the 12-wide KES amount column
            const entries = Array.isArray(sale.items) ? sale.items : [];
            const sumItems = entries.reduce((s, l) => s + l.price * l.qty, 0);
            const total = hooks.total ? hooks.total(sale, sumItems) : sumItems;
            const date = new Date(sale.timestamp);
            const isBill = sale.paymentMethod === 'bill' || sale.paymentMethod === 'pod' || sale.paid === false;
            const kes = (n) => 'KES ' + Number(n || 0).toFixed(2);
            const showRef = !!sale.refNumber && (typeof receiptShowRefNumber === 'undefined' || receiptShowRefNumber);
            const showBarcode = showRef && (typeof receiptShowBarcode === 'undefined' || receiptShowBarcode);
            const ctx = { isBill, total, cols, rule, labelCol, kes };

            // ---- header (always centred) ----
            const headerLines = [];
            headerLines.push((businessName || hooks.defaultName || 'Business POS').toUpperCase());
            if (receiptEmail) headerLines.push(receiptEmail);
            if (receiptContact) headerLines.push(receiptContact);
            if (receiptExtraInfo) receiptExtraInfo.split('\n').forEach(l => { if (l.trim()) headerLines.push(l.trim()); });
            if (etimsPin) headerLines.push(`KRA PIN: ${etimsPin}`);
            const docLabel = hooks.docLabel ? hooks.docLabel(sale, ctx) : (isBill ? 'BILL / INVOICE' : 'Sales Receipt');
            headerLines.push(docLabel);
            headerLines.push(rule);
            // One line when it fits (80 mm), otherwise Date and Time on lines of their own — never wrapped mid-way (zip 144)
            const dateTime = `Date: ${date.toLocaleDateString('en-GB')}   Time: ${date.toLocaleTimeString('en-GB')}`;
            if (dateTime.length <= cols) headerLines.push(dateTime);
            else { headerLines.push(`Date: ${date.toLocaleDateString('en-GB')}`); headerLines.push(`Time: ${date.toLocaleTimeString('en-GB')}`); }
            headerLines.push(`Served by: ${sale.servedBy || adminServerName()}`);   // bills and receipts always say who served
            if (sale.customerName) headerLines.push(`Customer: ${sale.customerName}`);
            if (sale.tableOrRoom) {
                // a module can say what the place is (Table 12 / Room 104) instead of the generic line (zip 144)
                const loc = hooks.locationLines ? hooks.locationLines(sale) : null;
                (Array.isArray(loc) ? loc : [`Table/Room: ${sale.tableOrRoom}`]).forEach(l => { if (l) headerLines.push(l); });
            }
            if (hooks.headerExtra) (hooks.headerExtra(sale) || []).forEach(l => headerLines.push(l));

            // ---- item rows: one data set feeds BOTH the text and the on-screen table ----
            const hasQtyFmt = typeof formatQtyDisplay === 'function' && typeof unitLabel === 'function';
            const rows = entries.map(l => {
                const unit = l.unit || 'pcs';
                const qtyNum = hasQtyFmt ? formatQtyDisplay(l.qty, unit) : String(l.qty);
                const base = {
                    text: { name: l.name, qty: hasQtyFmt ? qtyNum + unitLabel(unit) : qtyNum, price: Number(l.price).toFixed(2), amount: (l.price * l.qty).toFixed(2) },
                    html: { name: l.name, qty: qtyNum, price: Number(l.price).toFixed(2), amount: (l.price * l.qty).toFixed(2) },
                };
                const o = (hooks.itemCells && hooks.itemCells(l, sale)) || {};
                const subs = [];
                if (l.dosage) subs.push('--> Dose: ' + l.dosage);        // a medicine's dosage instruction (1 x 3 for 5 days ...)
                if (l.offerApplied) subs.push(`Offer: ${l.offerApplied.label} (-KES ${Number(l.offerApplied.amount).toFixed(2)})`);
                if (Array.isArray(l.componentsUsed)) l.componentsUsed.forEach(c => subs.push(`Uses: ${hasQtyFmt ? formatQtyDisplay(c.qty, c.unit) + unitLabel(c.unit) : c.qty} ${c.name}`));
                if (hooks.itemSubLines) (hooks.itemSubLines(l, sale) || []).forEach(s => subs.push(s));
                return { sec: hooks.sectionOf ? (hooks.sectionOf(l, sale) || null) : null, code: l.code || '', vat: l.type === 'payment' ? '' : (l.vatCategory || 'A'), text: Object.assign({}, base.text, o.text), html: Object.assign({}, base.html, o.html), subs };
            });

            const lines = [];
            lines.push(rule);
            lines.push(...thermalItemHeader(cols));
            // Optional SECTIONS (hooks.sectionOf): a sale with both kinds of line (hospital fees AND dispensed medicines) lists them
            // under a heading each. With one kind only, or no hook, the receipt is exactly as before.
            const secOrder = hooks.sectionOrder ? hooks.sectionOrder.filter(x => rows.some(r => r.sec === x)) : rows.map(r => r.sec).filter((x, i, a) => x && a.indexOf(x) === i);
            const showSections = secOrder.length > 1;
            const orderedRows = showSections ? [...rows].sort((a, b) => secOrder.indexOf(a.sec) - secOrder.indexOf(b.sec)) : rows;
            let textLastSec = null;
            orderedRows.forEach(r => {
                if (showSections && r.sec !== textLastSec) { textLastSec = r.sec; lines.push(r.sec || ''); }
                lines.push(...thermalItemRow(cols, r.text.name, r.code, r.text.qty, r.text.price, r.text.amount, r.vat));
                r.subs.forEach(s => lines.push('  ' + s));
            });
            const afterItemLines = hooks.afterItems ? (hooks.afterItems(sale, ctx) || []) : [];
            afterItemLines.forEach(l => lines.push(l));

            lines.push(rule);
            const totalLineIndex = lines.length;
            const totalLabel = hooks.totalLabel ? hooks.totalLabel(sale) : 'TOTAL';
            lines.push(...receiptMoneyRow(totalLabel, kes(total), cols));
            const cartLevelOffers = Array.isArray(sale.cartOffersApplied)
                ? sale.cartOffersApplied.filter(o => !entries.some(it => it.offerApplied && it.offerApplied.offerName === o.offerName && it.offerApplied.amount === o.amount && it.offerApplied.label === o.label))
                : [];
            cartLevelOffers.forEach(o => lines.push(`Offer: ${o.label} (-KES ${Number(o.amount).toFixed(2)})`));
            if (sale.totalDiscount > 0) lines.push(...receiptMoneyRow('Total Savings', kes(sale.totalDiscount), cols));

            // ---- payment ----
            const custom = hooks.paymentLines ? hooks.paymentLines(sale, ctx) : null;
            const method = sale.paymentMethod || 'cash';
            const mpesaRef = sale.mpesaReceiptNumber || sale.mpesaCode || '';
            if (custom) {
                custom.forEach(l => lines.push(l));
            } else if (isBill) {
                const paidNow = sale.amountPaid || 0;
                if (paidNow > 0) {
                    lines.push(...receiptMoneyRow('PAID', kes(paidNow), cols));
                    lines.push(...receiptMoneyRow('BALANCE', kes(Math.max(0, total - paidNow)), cols));
                    lines.push(`STATUS: ${method === 'pod' ? 'PAY ON DELIVERY' : 'PAY LATER'}`);
                } else {
                    lines.push(method === 'pod' ? 'STATUS: UNPAID — PAY ON DELIVERY' : 'STATUS: UNPAID — PAY LATER');
                }
                lines.push(rule);
                const details = receiptPaymentDetailsList();
                if (details.length) { lines.push('Please settle via:'); details.forEach(d => lines.push(d)); }
                else lines.push('Please contact us to arrange payment.');
            } else if (method === 'split') {
                lines.push(...receiptMoneyRow('Paid by Cash', kes(sale.cashAmount), cols));
                lines.push(...receiptMoneyRow('Paid by M-Pesa', kes(sale.mpesaAmount), cols));
                if (mpesaRef) lines.push(`M-Pesa Receipt: ${mpesaRef}`);
                if (sale.cashAmount > 0) {
                    lines.push(...receiptMoneyRow('Cash Tendered', kes(sale.amountTendered), cols));
                    lines.push(...receiptMoneyRow('CHANGE', kes(Math.max(0, sale.change || 0)), cols));
                }
            } else if (method === 'mpesa') {
                lines.push('Payment Method: M-PESA');
                if (mpesaRef) lines.push(`M-Pesa Receipt: ${mpesaRef}`);
            } else if (method === 'card') {
                lines.push('Payment Method: CARD');
                if (sale.cardReference) lines.push(`Card Ref: ${sale.cardReference}`);
            } else if (method !== 'cash') {
                lines.push(`Payment Method: ${String(method).toUpperCase()}`);
            } else {
                lines.push(...receiptMoneyRow('CASH', kes(sale.amountTendered), cols));
                lines.push(...receiptMoneyRow('CHANGE', kes(Math.max(0, sale.change || 0)), cols));
            }

            // ---- items count + VAT table (skipped for pure "payment" records such as bill instalments) ----
            const paymentRecord = entries.length > 0 && entries.every(l => l.type === 'payment');
            if (!paymentRecord) {
                lines.push(rule);
                lines.push(`TOTAL ITEMS: ${entries.length}`);
                const { groups } = computeVatBreakdown(entries);
                const catKeys = Object.keys(groups).sort();
                if (catKeys.length > 0) {
                    lines.push(thermalVatHeader(cols));
                    catKeys.forEach(cat => lines.push(thermalVatRow(cat, groups[cat], cols)));
                }
            }

            // ---- KRA eTIMS (two data shapes exist across the apps) ----
            if (sale.etimsData) {
                const e = sale.etimsData;
                lines.push(rule);
                lines.push('KRA eTIMS');
                lines.push(`CU Invoice No: ${e.invcNo}`);
                lines.push(`Receipt No: ${e.curRcptNo}/${e.totRcptNo}`);
                lines.push(`Internal Data: ${e.intrlData || ''}`);
                lines.push(`Receipt Signature: ${e.rcptSign || ''}`);
                lines.push(`SDC Date: ${e.sdcDateTime || ''}`);
            } else if (sale.etimsStatus === 'submitted' && sale.etimsCurRcptNo) {
                lines.push(rule);
                lines.push(`KRA Invoice No: ${sale.etimsInvoiceNo || ''}`);
                lines.push(`SCU Receipt No: ${sale.etimsCurRcptNo}/${sale.etimsTotRcptNo}`);
                if (sale.etimsSdcDateTime) lines.push(`SCU Date: ${sale.etimsSdcDateTime}`);
            }

            // ---- footer (always centred) ----
            const footerLines = [];
            if (!isBill) {
                // Payment details now print on EVERY receipt, not only on bills.
                const details = receiptPaymentDetailsList();
                if (details.length) { footerLines.push(rule); footerLines.push('Payment details:'); details.forEach(d => footerLines.push(d)); }
            }
            footerLines.push(rule);
            footerLines.push(isBill ? 'Thank you — kindly settle this bill promptly.' : 'Thank you for your business!');
            const footerNotes = String((hooks.footerNotes ? hooks.footerNotes(sale) : receiptFooterNotes) || '').trim();
            if (footerNotes) {
                footerLines.push(rule);
                footerNotes.split('\n').forEach(n => { if (n.trim()) footerLines.push(n.trim()); });
            }
            const customerNo = assignCustomerNo(sale);                    // "Customer 12": how many customers were served today
            if (showRef || customerNo) footerLines.push(rule);
            if (customerNo) footerLines.push(`Customer ${customerNo}`);
            if (showRef) footerLines.push(`Ref: ${sale.refNumber}`);

            // ---- on-screen / system-print version (zip 144): the SAME lines the printer gets, laid out on the same character grid ----
            // It used to be a separate HTML table plus pre-wrap text at a fixed 12-13 px. On 58 mm paper that is ~23 characters a line
            // for text laid out for 32 or 48: the browser re-wrapped it — words and numbers split, columns out of line, and the preview
            // (always drawn 80 mm wide) looked fine while the paper did not.
            const itemAlign = receiptItemAlign === 'center' ? 'center' : receiptItemAlign === 'right' ? 'right' : 'left';
            const boldItem = (l) => /^\s*(TOTAL|AMOUNT DUE TODAY|DUE NOW|ITEM\s+QTY)\b/.test(l);
            const headBold = (l, i) => i === 0 || l.trim() === String(docLabel).trim();
            let barcodeHtml = '';
            if (showBarcode) {
                // sized to the printable width: never wider than the paper (it was a fixed size and ran off 58 mm paper)
                const n = String(sale.refNumber).length + 2;
                const fitPx = receiptPrintableMm() * 96 / 25.4;
                const narrow = Math.max(0.6, Math.min(1.5, fitPx / (14.5 * n + 20)));
                barcodeHtml = `<div class="receipt-grid-barcode">${renderCode39SVG(sale.refNumber, { height: 40, narrow })}</div>`;
            }
            const html = receiptGridHtml([
                { lines: headerLines, align: 'center', bold: headBold },
                { lines, align: itemAlign, bold: boldItem },
                { lines: footerLines, align: 'center' },
            ], { cols }) + barcodeHtml;

            return { html, headerLines, lines, footerLines, total,
                text: [...headerLines, ...lines, ...footerLines].join('\n'),
                header: headerLines.join('\n'), items: lines.join('\n'), footer: footerLines.join('\n') };
        }

//@fn renderSharedReceipt
function renderSharedReceipt(sale, hooks) {
            hooks = hooks || {};
            const doc = buildReceiptDoc(sale, hooks);
            const receiptBodyEl = document.getElementById('receipt-body');
            receiptBodyEl.innerHTML = doc.html;
            lastReceiptText = doc.text;
            lastReceiptHeader = doc.header;
            lastReceiptItemSection = doc.items;
            lastReceiptFooter = doc.footer;
            currentReceiptSale = sale;
            try { if (typeof window.salesJournalReceiptStatus === 'function') window.salesJournalReceiptStatus(sale); } catch (e) { /* cosmetic */ }
            if (typeof applyReceiptAlignToPaper === 'function') applyReceiptAlignToPaper();

            // Logo / QR: shown only when an image is saved AND its checkbox is ticked.
            const logoBlock = document.getElementById('receipt-logo-block');
            if (logoBlock) {
                if (receiptShowLogo && receiptLogoData) {
                    document.getElementById('receipt-logo-img').src = receiptLogoData;
                    logoBlock.style.display = 'block';
                } else {
                    logoBlock.style.display = 'none';
                }
            }
            const qrBlock = document.getElementById('receipt-qr-block');
            if (qrBlock) {
                if (receiptShowQr && receiptQrData) {
                    document.getElementById('receipt-qr-img').src = receiptQrData;
                    document.getElementById('receipt-qr-caption').textContent = receiptQrCaption || '';
                    qrBlock.style.display = 'block';
                } else {
                    qrBlock.style.display = 'none';
                }
            }

            // In System print dialog mode the drawer-kick command rides inside the receipt's own print job.
            if (printerMode === 'system' && autoOpenDrawerEnabled) {
                const kickSpan = document.createElement('span');
                kickSpan.className = 'drawer-kick-bytes';
                kickSpan.textContent = buildDrawerKickAsciiString();
                receiptBodyEl.appendChild(kickSpan);
            }

            const modal = document.getElementById('receipt-modal');
            modal.dataset.saleId = sale.id || '';
            modal.style.display = 'flex';
            if (hooks.autoPrint !== false) triggerAutoPrintReceipt();
        }

//@fn adminServerName
function adminServerName() {
            // Who to show when a record has no "served by": sales the owner rang up themselves used to be
            // saved with nobody on them (see activeServerName), so an empty value means the admin.
            return (ownerName || '').trim() || 'Admin';
        }

//@fn sha256HexFallback
function sha256HexFallback(text) {
            // Real SHA-256 in plain JS, used only when the browser has no Web Crypto (crypto.subtle exists only on HTTPS /
            // localhost). It returns EXACTLY what crypto.subtle.digest('SHA-256') would, so a password hashed here matches
            // one hashed anywhere else. (This replaces a 32-bit rolling hash that collided trivially and never matched
            // hashes made on other devices.)
            const bytes = new TextEncoder().encode(String(text));
            const K = [], H = [];
            for (let n = 2, c = 0; c < 64; n++) {
                let prime = true;
                for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
                if (!prime) continue;
                if (c < 8) H[c] = (Math.pow(n, 1 / 2) % 1) * 4294967296 | 0;
                K[c++] = (Math.pow(n, 1 / 3) % 1) * 4294967296 | 0;
            }
            const len = bytes.length, padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
            padded.set(bytes);
            padded[len] = 0x80;
            const view = new DataView(padded.buffer);
            view.setUint32(padded.length - 8, Math.floor(len / 0x20000000), false);
            view.setUint32(padded.length - 4, (len << 3) >>> 0, false);
            const w = new Int32Array(64);
            const rotr = (x, n) => (x >>> n) | (x << (32 - n));
            for (let off = 0; off < padded.length; off += 64) {
                for (let i = 0; i < 16; i++) w[i] = view.getInt32(off + i * 4, false);
                for (let i = 16; i < 64; i++) {
                    const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
                    const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
                    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
                }
                let [a, b, c, d, e, f, g, h] = H;
                for (let i = 0; i < 64; i++) {
                    const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
                    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
                    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
                }
                H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
                H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
            }
            return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
        }

//@fn shareReceiptNative
async function shareReceiptNative() {
            // Share ALWAYS sends the receipt as a PDF file (WhatsApp shows it as a document), never as pasted text.
            // Browsers that can't hand a file to another app get the PDF saved to the device instead, so it can be
            // attached by hand. If the PDF can't be made, nothing is sent rather than falling back to text.
            const text = (lastReceiptText || '').trim();
            if (!text) { showToast('Nothing to share yet.', true); return; }
            const ref = (currentReceiptSale && (currentReceiptSale.refNumber || currentReceiptSale.id)) || Date.now();
            const shareTitle = businessName || 'Receipt';
            const fileName = `receipt-${ref}.pdf`;

            let blob = null;
            try { blob = await textToPdfBlob(text, { width: receiptImageWidthPx() }); } catch (e) { blob = null; }
            if (!blob) { showToast('Could not create the receipt PDF — nothing was shared.', true); return; }
            const file = new File([blob], fileName, { type: 'application/pdf' });

            if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    // Only the file is passed — a "text" field makes some apps (WhatsApp) send the text instead.
                    await navigator.share({ files: [file], title: shareTitle });
                    return;
                } catch (e) {
                    if (e && e.name === 'AbortError') return; // person closed the share sheet — not an error
                    // any other failure falls through to saving the PDF
                }
            }
            downloadBlob(blob, fileName);
            // This browser cannot hand a file to WhatsApp / other apps directly (most computers and some phone browsers can't), so the PDF is saved instead.
            showToast('Receipt PDF saved to your Downloads — this browser can’t share files directly, so attach it in WhatsApp, email or any app. (On a phone, Share opens your apps.)');
        }

//@fn buildCode39RasterBytes
function buildCode39RasterBytes(value, maxDots) {
            // The same Code 39 barcode the on-screen receipt shows, drawn as a monochrome bitmap and sent with
            // GS v 0 (raster image) so USB and Bluetooth receipts print it too. Works on any ESC/POS printer that
            // can print images, with no barcode font/command support needed. Returns null if it cannot fit.
            const chars = ('*' + sanitizeBarcodeValue(value) + '*').split('').filter(c => CODE39_TABLE[c]);
            if (chars.length < 3) return null;
            const widthDots = Math.floor(Math.min(Math.max(maxDots || 384, 192), 576) / 8) * 8;
            const total = (n, w) => chars.reduce((sum, c) => sum + CODE39_TABLE[c].split('').reduce((t, e) => t + (e === 'W' ? w : n), 0), 0) + (chars.length - 1) * n;
            // [narrow, wide] bar widths in printer dots, widest that still fits (wide:narrow stays between 2 and 3)
            const fit = [[3, 8], [3, 7], [2, 5], [2, 4], [1, 3], [1, 2]].find(([n, w]) => total(n, w) <= widthDots - 12);
            if (!fit) return null;
            const [n, w] = fit;
            const bytesPerRow = widthDots / 8;
            const height = 56;   // about 7 mm
            const row = new Uint8Array(bytesPerRow);
            let x = Math.floor((widthDots - total(n, w)) / 2);
            chars.forEach(c => {
                CODE39_TABLE[c].split('').forEach((e, i) => {
                    const len = e === 'W' ? w : n;
                    if (i % 2 === 0) for (let k = 0; k < len; k++) { const px = x + k; row[px >> 3] |= 0x80 >> (px & 7); }
                    x += len;
                });
                x += n;   // gap between characters
            });
            const out = new Uint8Array(8 + bytesPerRow * height);
            out.set([0x1D, 0x76, 0x30, 0x00, bytesPerRow & 0xFF, bytesPerRow >> 8, height & 0xFF, height >> 8], 0);   // GS v 0 m xL xH yL yH
            for (let r = 0; r < height; r++) out.set(row, 8 + r * bytesPerRow);
            return out;
        }

//@fn receiptRefBarcodeBytes
function receiptRefBarcodeBytes(footerText) {
            // The receipt footer ends with "Ref: <number>" when the sale has one; raw printers get its barcode
            // right under it, unless the reference number / barcode is switched off in Settings.
            const last = String(footerText || '').replace(/\r/g, '').split('\n').pop().trim();
            const m = /^Ref: (\S+)$/.exec(last);
            if (!m) return null;
            if (typeof receiptShowRefNumber !== 'undefined' && !receiptShowRefNumber) return null;
            if (typeof receiptShowBarcode !== 'undefined' && !receiptShowBarcode) return null;
            try { return buildCode39RasterBytes(m[1], getPaperCols() * 12); } catch (e) { return null; }
        }

//@fn poState
function poState() {
            // All Orders-tab UI state lives on one object so the module needs no top-level
            // `let`s (only function declarations can live in the shared region). The persisted
            // data itself is the app-level `purchaseOrders` array, which is synced like suppliers.
            if (!window.__poState) {
                window.__poState = {
                    draft: [], rowSeq: 1, editingId: null,
                    filter: 'active', expanded: {},
                    arriveOrderId: null, arriveLines: {}, arriveBusy: false,
                };
            }
            return window.__poState;
        }

//@fn poNewRow
function poNewRow() {
            const st = poState();
            return { rowId: st.rowSeq++, lineId: null, code: '', name: '', unit: 'pcs', qty: '', cost: '', retail: '', wholesale: '', autoCode: '' };
        }

//@fn poRound3
function poRound3(n) {
            return Math.round((Number(n) || 0) * 1000) / 1000;
        }

//@fn poFormatDateTime
function poFormatDateTime(iso) {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
            const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            return `${date}, ${time}`;
        }

//@fn poStatusMeta
function poStatusMeta(status) {
            return ({
                pending: { label: 'Pending', icon: '🕓' },
                in_transit: { label: 'In Transit', icon: '🚚' },
                received: { label: 'Received', icon: '✅' },
                cancelled: { label: 'Cancelled', icon: '✖' },
                partial: { label: 'Partly received', icon: '📦' },
            })[status] || { label: String(status || ''), icon: '' };
        }

//@fn poLineOutstanding
function poLineOutstanding(item) {
            const left = poRound3((Number(item.qty) || 0) - (Number(item.receivedQty) || 0));
            return left > 0 ? left : 0;
        }

//@fn poOrderStats
function poOrderStats(order) {
            const items = Array.isArray(order.items) ? order.items : [];
            const units = new Set();
            let cost = 0, qty = 0, receivedLines = 0, outstandingLines = 0;
            items.forEach(it => {
                cost += (Number(it.qty) || 0) * (Number(it.cost) || 0);
                qty += Number(it.qty) || 0;
                units.add(it.unit || 'pcs');
                if ((Number(it.receivedQty) || 0) > 0) receivedLines++;
                if (poLineOutstanding(it) > 0) outstandingLines++;
            });
            return { lines: items.length, qty: poRound3(qty), cost, receivedLines, outstandingLines, singleUnit: units.size === 1 ? [...units][0] : null };
        }

//@fn poIsOpen
function poIsOpen(order) {
            return !!order && !order.removed && (order.status === 'pending' || order.status === 'in_transit');
        }

//@fn poCanEdit
function poCanEdit(order) {
            // Once any stock from an order has been committed to inventory, its lines are history.
            return poIsOpen(order) && poOrderStats(order).receivedLines === 0;
        }

//@fn poFindProduct
function poFindProduct(code, name) {
            // Same matching rule as Restock: a code is unambiguous and wins; only with no code
            // do we fall back to a case-insensitive name match. Services are never stocked.
            const c = String(code || '').trim().toLowerCase();
            const n = String(name || '').trim().toLowerCase();
            const stocked = inventory.filter(p => p.type !== 'service');
            if (c) return stocked.find(p => String(p.code || '').toLowerCase() === c) || null;
            if (n) return stocked.find(p => String(p.name || '').trim().toLowerCase() === n) || null;
            return null;
        }

//@fn poSave
function poSave() {
            safeSetItem('pos_purchase_orders', JSON.stringify(purchaseOrders));
            queuePush();
        }

//@fn poNextOrderNo
function poNextOrderNo() {
            // Derived from the data (highest existing PO-#### + 1) rather than a separate counter,
            // so there is nothing extra to keep in sync between devices.
            let max = 0;
            purchaseOrders.forEach(o => {
                const m = /^PO-(\d+)$/.exec(String(o.orderNo || ''));
                if (m) max = Math.max(max, parseInt(m[1], 10));
            });
            return 'PO-' + String(max + 1).padStart(4, '0');
        }

//@fn poActor
function poActor() {
            return (typeof activeServerName === 'function') ? activeServerName() : '';
        }

//@fn poRefreshFormLists
function poRefreshFormLists() {
            const sl = document.getElementById('po-supplier-list');
            if (sl) {
                sl.innerHTML = (Array.isArray(suppliers) ? suppliers : [])
                    .filter(s => s && s.name)
                    .map(s => `<option value="${escapeHtml(s.name)}">`).join('');
            }
            const il = document.getElementById('po-item-names');
            if (il) {
                il.innerHTML = inventory.filter(p => p.type !== 'service')
                    .map(p => `<option value="${escapeHtml(p.name)}">`).join('');
            }
        }

//@fn poOpenForm
function poOpenForm(orderId) {
            const panel = document.getElementById('po-form-panel');
            if (!panel) return;
            const st = poState();
            let order = null;
            if (orderId) {
                order = purchaseOrders.find(o => o.id === orderId && !o.removed) || null;
                if (!order) return;
                if (!poCanEdit(order)) { showToast('This order can no longer be edited.', true); return; }
            }
            st.editingId = order ? order.id : null;
            st.draft = [];
            if (order) {
                order.items.forEach(it => st.draft.push({
                    rowId: st.rowSeq++, lineId: it.id, code: it.code || '', name: it.name || '', unit: it.unit || 'pcs',
                    qty: String(it.qty), cost: String(it.cost),
                    retail: it.retailPrice == null ? '' : String(it.retailPrice),
                    wholesale: it.wholesalePrice == null ? '' : String(it.wholesalePrice),
                    autoCode: '',
                }));
            }
            if (st.draft.length === 0) st.draft.push(poNewRow());

            document.getElementById('po-form-title').textContent = order ? `✏️ Edit Order ${order.orderNo}` : '🛍️ New Order';
            document.getElementById('po-supplier-input').value = order ? (order.supplierName || '') : '';
            document.getElementById('po-note-input').value = order ? (order.note || '') : '';
            document.getElementById('po-datetime-display').textContent = order
                ? `Created ${poFormatDateTime(order.createdAt)}`
                : `Stamped automatically when you save (now: ${poFormatDateTime(new Date().toISOString())})`;
            const formMsg = document.getElementById('po-form-msg');
            formMsg.textContent = '';
            formMsg.className = 'settings-msg';
            poRefreshFormLists();
            panel.style.display = '';
            poRenderRows();
            if (typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

//@fn poCloseForm
function poCloseForm() {
            const panel = document.getElementById('po-form-panel');
            if (panel) panel.style.display = 'none';
            const st = poState();
            st.editingId = null;
            st.draft = [];
        }

//@fn poAddRow
function poAddRow() {
            poState().draft.push(poNewRow());
            poRenderRows();
        }

//@fn poRemoveRow
function poRemoveRow(rowId) {
            const st = poState();
            st.draft = st.draft.filter(r => r.rowId !== rowId);
            if (st.draft.length === 0) st.draft.push(poNewRow());
            poRenderRows();
        }

//@fn poRowLineTotal
function poRowLineTotal(row) {
            const q = parseQtyInput(row.qty);
            const c = parseFloat(row.cost);
            return (q > 0 && c >= 0) ? q * c : 0;
        }

//@fn poRenderTotals
function poRenderTotals() {
            const rows = poState().draft;
            const total = rows.reduce((sum, r) => sum + poRowLineTotal(r), 0);
            const lines = rows.filter(r => r.name.trim() || r.code.trim()).length;
            const totalEl = document.getElementById('po-grand-total');
            if (totalEl) totalEl.textContent = money(total);
            const countEl = document.getElementById('po-item-count');
            if (countEl) countEl.textContent = String(lines);
        }

//@fn poRenderRows
function poRenderRows() {
            const tbody = document.getElementById('po-rows-tbody');
            if (!tbody) return;
            const canScan = typeof openBarcodeScanModal === 'function' && typeof setFieldAndFireInput === 'function';
            const baseUnits = ['pcs', 'kg', 'm', 'l', 'in', 'ft'];
            tbody.innerHTML = poState().draft.map(r => {
                const units = baseUnits.includes(r.unit) ? baseUnits : [...baseUnits, r.unit];
                return `
                <tr>
                    <td data-label="Code (optional)"><div class="po-code-cell"><input type="text" id="po-row-${r.rowId}-code" placeholder="optional" value="${escapeHtml(r.code)}" oninput="poUpdateRowField(${r.rowId}, 'code', this.value)">${canScan ? `<button type="button" class="settings-small-btn po-scan-btn" title="Scan barcode" onclick="openBarcodeScanModal(code => setFieldAndFireInput('po-row-${r.rowId}-code', code))">📷</button>` : ''}</div></td>
                    <td data-label="Item / Product"><input type="text" id="po-row-${r.rowId}-name" data-suggest="po" data-row="${r.rowId}" autocomplete="off" placeholder="Type a name — pick from your items, or type a new one" value="${escapeHtml(r.name)}" oninput="poUpdateRowField(${r.rowId}, 'name', this.value)" onchange="poFillRowFromProduct(${r.rowId})"></td>
                    <td data-label="Unit"><select id="po-row-${r.rowId}-unit" onchange="poUpdateRowField(${r.rowId}, 'unit', this.value)">${units.map(u => `<option value="${u}" ${r.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></td>
                    <td data-label="Quantity"><input type="text" inputmode="decimal" id="po-row-${r.rowId}-qty" placeholder="e.g. 4" value="${escapeHtml(r.qty)}" oninput="poUpdateRowField(${r.rowId}, 'qty', this.value)"></td>
                    <td data-label="Cost Price / Unit"><input type="number" min="0" step="0.01" id="po-row-${r.rowId}-cost" value="${escapeHtml(r.cost)}" oninput="poUpdateRowField(${r.rowId}, 'cost', this.value)"></td>
                    <td data-label="Retail Price (optional)"><input type="number" min="0" step="0.01" id="po-row-${r.rowId}-retail" placeholder="optional" value="${escapeHtml(r.retail)}" oninput="poUpdateRowField(${r.rowId}, 'retail', this.value)"></td>
                    <td data-label="Wholesale Price (optional)"><input type="number" min="0" step="0.01" id="po-row-${r.rowId}-wholesale" placeholder="optional" value="${escapeHtml(r.wholesale)}" oninput="poUpdateRowField(${r.rowId}, 'wholesale', this.value)"></td>
                    <td class="po-line-total" data-label="Line Total" data-row-id="${r.rowId}">${money(poRowLineTotal(r))}</td>
                    <td class="po-cell-del"><button type="button" class="settings-small-btn po-del-btn" title="Remove line" onclick="poRemoveRow(${r.rowId})">🗑️</button></td>
                </tr>
            `;
            }).join('');
            poRenderTotals();
            if (typeof renderLowStockStrip === 'function') renderLowStockStrip('po');
        }

//@fn poUpdateRowField
function poUpdateRowField(rowId, field, value) {
            const row = poState().draft.find(r => r.rowId === rowId);
            if (!row) return;
            row[field] = value;
            if (field === 'qty' || field === 'cost') {
                const cell = document.querySelector(`#po-rows-tbody .po-line-total[data-row-id="${rowId}"]`);
                if (cell) cell.textContent = money(poRowLineTotal(row));
            }
            if (field === 'qty' || field === 'cost' || field === 'name' || field === 'code') poRenderTotals();
        }

//@fn poFillRowFromProduct
function poFillRowFromProduct(rowId) {
            // Picking (or typing) the exact name of a product you already stock links the line to it:
            // fills its code/unit and last cost, and shows its current prices as placeholders so it's
            // obvious that leaving Retail/Wholesale blank keeps them unchanged.
            const row = poState().draft.find(r => r.rowId === rowId);
            if (!row) return;
            const set = (field, value) => {
                const el = document.getElementById(`po-row-${rowId}-${field}`);
                if (el) el.value = value;
            };
            const p = row.name.trim() ? poFindProduct('', row.name) : null;
            if (!p) {
                // No longer matches anything — drop a code we auto-filled earlier, but never one the user typed.
                if (row.autoCode && row.code === row.autoCode) { row.code = ''; row.autoCode = ''; set('code', ''); }
                const rEl = document.getElementById(`po-row-${rowId}-retail`);
                const wEl = document.getElementById(`po-row-${rowId}-wholesale`);
                if (rEl) rEl.placeholder = 'optional';
                if (wEl) wEl.placeholder = 'optional';
                return;
            }
            if (!row.code.trim() || row.code === row.autoCode) { row.code = p.code || ''; row.autoCode = row.code; set('code', row.code); }
            row.unit = p.unit || 'pcs';
            const unitEl = document.getElementById(`po-row-${rowId}-unit`);
            if (unitEl) {
                if (![...unitEl.options].some(o => o.value === row.unit)) unitEl.add(new Option(row.unit, row.unit));
                unitEl.value = row.unit;
            }
            if (row.cost === '' && Number(p.wholesalePrice) > 0) { row.cost = String(p.wholesalePrice); set('cost', row.cost); }
            const rEl = document.getElementById(`po-row-${rowId}-retail`);
            const wEl = document.getElementById(`po-row-${rowId}-wholesale`);
            if (rEl) rEl.placeholder = Number(p.price) > 0 ? `optional (now ${p.price})` : 'optional';
            if (wEl) wEl.placeholder = Number(p.wholesaleSellingPrice) > 0 ? `optional (now ${p.wholesaleSellingPrice})` : 'optional';
            const cell = document.querySelector(`#po-rows-tbody .po-line-total[data-row-id="${rowId}"]`);
            if (cell) cell.textContent = money(poRowLineTotal(row));
            poRenderTotals();
        }

//@fn poEnsureSupplier
function poEnsureSupplier(name) {
            // Returns the id of the supplier with this name, creating a master-list entry the first time a
            // new origin is typed so it's a one-tap pick next time (and shows up in Restock's picker too).
            const clean = String(name || '').trim();
            if (!clean) return { id: null, created: false };
            const found = suppliers.find(s => s && String(s.name || '').trim().toLowerCase() === clean.toLowerCase());
            if (found) return { id: found.id, created: false, name: found.name };
            const sup = { id: `sup-${genSaleId()}`, name: clean, phone: '' };
            suppliers.push(sup);
            safeSetItem('pos_suppliers', JSON.stringify(suppliers));
            if (typeof renderSupplierDropdowns === 'function') renderSupplierDropdowns();
            return { id: sup.id, created: true, name: sup.name };
        }

//@fn poSaveOrder
function poSaveOrder(sendAfter) {
            const st = poState();
            const msgEl = document.getElementById('po-form-msg');
            const fail = (text) => { msgEl.textContent = text; msgEl.className = 'settings-msg error'; };
            const supplierTyped = document.getElementById('po-supplier-input').value.trim();
            const note = document.getElementById('po-note-input').value.trim();

            const items = [];
            for (const r of st.draft) {
                const name = r.name.trim();
                const code = r.code.trim();
                const label = name || code;
                // A row nobody touched isn't an error — the form always keeps one spare row.
                if (!name && !code && r.qty.trim() === '' && String(r.cost).trim() === '' && r.retail === '' && r.wholesale === '') continue;
                if (!label) return fail('Every line needs an item name or code.');
                const qty = parseQtyInput(r.qty);
                if (!(qty > 0)) return fail(`Enter a quantity for "${label}".`);
                const cost = parseFloat(r.cost);
                if (!(cost >= 0)) return fail(`Enter the cost price for "${label}".`);
                let retailPrice = null, wholesalePrice = null;
                if (String(r.retail).trim() !== '') {
                    retailPrice = parseFloat(r.retail);
                    if (!(retailPrice > 0)) return fail(`Retail price for "${label}" must be above 0 — or leave it blank.`);
                }
                if (String(r.wholesale).trim() !== '') {
                    wholesalePrice = parseFloat(r.wholesale);
                    if (!(wholesalePrice > 0)) return fail(`Wholesale price for "${label}" must be above 0 — or leave it blank.`);
                }
                items.push({
                    id: r.lineId || `pl-${genSaleId()}`, code, name: label, unit: r.unit || 'pcs',
                    qty, cost, retailPrice, wholesalePrice, receivedQty: 0,
                });
            }
            if (items.length === 0) return fail('Add at least one item with a quantity and cost price.');

            const sup = poEnsureSupplier(supplierTyped);
            const supplierName = sup.name || supplierTyped;
            const nowIso = new Date().toISOString();
            let order;
            if (st.editingId) {
                order = purchaseOrders.find(o => o.id === st.editingId && !o.removed);
                if (!order || !poCanEdit(order)) return fail('This order was changed on another device and can no longer be edited.');
                order.supplierId = sup.id; order.supplierName = supplierName; order.note = note; order.items = items;
            } else {
                order = {
                    id: `po-${genSaleId()}`, orderNo: poNextOrderNo(), createdAt: nowIso, createdBy: poActor(),
                    supplierId: sup.id, supplierName, note, items,
                    status: 'pending', receivedAt: null,
                    statusHistory: [{ status: 'pending', at: nowIso, by: poActor() }],
                };
                purchaseOrders.push(order);
            }
            poSave();
            poCloseForm();
            st.filter = 'active';
            renderOrdersList();
            showToast(`${order.orderNo} saved${sup.created ? ` — "${supplierName}" added to your suppliers` : ''}.`);
            if (sendAfter === true) poSendOrder(order.id);                 // "Save & send on WhatsApp"
        }

//@fn poSetFilter
function poSetFilter(filter) {
            poState().filter = filter;
            renderOrdersList();
        }

//@fn poVisibleOrders
function poVisibleOrders() {
            const f = poState().filter;
            return purchaseOrders
                .filter(o => !o.removed)
                .filter(o => f === 'all' ? true : f === 'active' ? (o.status === 'pending' || o.status === 'in_transit') : o.status === f)
                .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        }

//@fn poToggleDetails
function poToggleDetails(orderId) {
            const st = poState();
            st.expanded[orderId] = !st.expanded[orderId];
            renderOrdersList();
        }

//@fn poActionsHtml
function poActionsHtml(o) {
            const id = escapeJsAttr(o.id);
            const stats = poOrderStats(o);
            const btn = (cls, label, fn) => `<button type="button" class="settings-small-btn po-btn ${cls}" onclick="${fn}('${id}')">${label}</button>`;
            const parts = [];
            if (o.status === 'pending') parts.push(btn('po-btn-transit', '🚚 In Transit', 'poMarkInTransit'));
            if (poIsOpen(o)) parts.push(btn('po-btn-arrived', '📦 Arrived', 'poOpenArriveModal'));
            if (o.status !== 'cancelled') parts.push(btn('po-btn-send', '💬 WhatsApp', 'poSendOrder'));
            if (poCanEdit(o)) parts.push(btn('po-btn-edit', '✏️ Edit', 'poOpenForm'));
            if (poIsOpen(o) && stats.receivedLines > 0) parts.push(btn('po-btn-edit', '✔ Close order', 'poCloseShort'));
            if (poCanEdit(o)) parts.push(btn('po-btn-cancel', '✖ Cancel', 'poCancelOrder'));
            if (o.status === 'cancelled') parts.push(btn('po-btn-cancel', '🗑️ Remove', 'poRemoveOrder'));
            parts.push(btn('po-btn-details', poState().expanded[o.id] ? '▴ Hide' : '▾ Details', 'poToggleDetails'));
            return `<div class="po-actions">${parts.join('')}</div>`;
        }

//@fn poDetailsHtml
function poDetailsHtml(o) {
            const lines = (o.items || []).map(it => {
                const got = Number(it.receivedQty) || 0;
                const qtyText = got > 0
                    ? `${formatQtyDisplay(got, it.unit)} of ${formatQtyDisplay(it.qty, it.unit)}`
                    : formatQtyDisplay(it.qty, it.unit);
                return `<tr>
                    <td>${escapeHtml(it.name)}${it.code ? ` <span class="po-sub">(${escapeHtml(it.code)})</span>` : ''}</td>
                    <td data-label="Qty">${qtyText} ${escapeHtml(unitLabel(it.unit))}${got > 0 ? ' received' : ''}</td>
                    <td data-label="Cost / Unit">${money(it.cost)}</td>
                    <td data-label="Retail">${it.retailPrice != null ? money(it.retailPrice) : '—'}</td>
                    <td data-label="Wholesale">${it.wholesalePrice != null ? money(it.wholesalePrice) : '—'}</td>
                    <td data-label="Line Total">${money((Number(it.qty) || 0) * (Number(it.cost) || 0))}</td>
                </tr>`;
            }).join('');
            const history = (o.statusHistory || []).map(h => {
                const meta = poStatusMeta(h.status);
                return `${meta.icon} ${escapeHtml(meta.label)} — ${escapeHtml(poFormatDateTime(h.at))}${h.by ? ` · ${escapeHtml(h.by)}` : ''}`;
            }).join('<br>');
            return `
                ${o.note ? `<p class="po-note">📝 ${escapeHtml(o.note)}</p>` : ''}
                ${o.sentToSupplierAt ? `<p class="po-note">💬 Sent to supplier ${escapeHtml(poFormatDateTime(o.sentToSupplierAt))}</p>` : ''}
                <div class="table-scroll"><table class="po-detail-table">
                    <thead><tr><th>Item</th><th>Qty</th><th>Cost/Unit</th><th>Retail</th><th>Wholesale</th><th>Line Total</th></tr></thead>
                    <tbody>${lines}</tbody>
                </table></div>
                <p class="po-history">${history}</p>`;
        }

//@fn renderOrdersList
function renderOrdersList() {
            const tbody = document.getElementById('po-orders-tbody');
            if (!tbody) return;
            const st = poState();
            const live = purchaseOrders.filter(o => !o.removed);
            const counts = {
                active: live.filter(o => o.status === 'pending' || o.status === 'in_transit').length,
                received: live.filter(o => o.status === 'received').length,
                cancelled: live.filter(o => o.status === 'cancelled').length,
                all: live.length,
            };
            document.querySelectorAll('#po-filter-chips .po-chip').forEach(btn => {
                const f = btn.dataset.filter;
                btn.classList.toggle('active', f === st.filter);
                const c = btn.querySelector('.po-chip-count');
                if (c) c.textContent = String(counts[f] || 0);
            });

            const list = poVisibleOrders();
            if (list.length === 0) {
                const msg = { active: 'No active orders. Tap “New Order” to record one.', received: 'No received orders yet.', cancelled: 'No cancelled orders.', all: 'No orders yet.' }[st.filter];
                tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${msg}</td></tr>`;
                return;
            }
            tbody.innerHTML = list.map(o => {
                const stats = poOrderStats(o);
                const meta = poStatusMeta(o.status);
                const partial = poIsOpen(o) && stats.receivedLines > 0;
                const qtyNote = stats.singleUnit ? `<div class="po-sub">Qty ${escapeHtml(formatQtyDisplay(stats.qty, stats.singleUnit))} ${escapeHtml(unitLabel(stats.singleUnit))}</div>` : '';
                const pill = `<span class="po-pill po-pill-${escapeHtml(o.status)}">${meta.icon} ${escapeHtml(meta.label)}</span>${partial ? `<div class="po-sub">${stats.receivedLines} of ${stats.lines} items received</div>` : ''}`;
                const detailRow = st.expanded[o.id] ? `<tr class="po-details-row"><td colspan="7">${poDetailsHtml(o)}</td></tr>` : '';
                return `<tr class="po-order-row">
                    <td class="po-cell-no"><strong>${escapeHtml(o.orderNo || '')}</strong></td>
                    <td data-label="Date &amp; Time">${escapeHtml(poFormatDateTime(o.createdAt))}</td>
                    <td data-label="Supplier">${o.supplierName ? escapeHtml(o.supplierName) : '<span class="po-sub">— not specified —</span>'}</td>
                    <td data-label="Total Items"><span>${stats.lines} item${stats.lines === 1 ? '' : 's'}${qtyNote}</span></td>
                    <td data-label="Total Cost">${money(stats.cost)}</td>
                    <td data-label="Status"><span>${pill}</span></td>
                    <td class="po-cell-actions">${poActionsHtml(o)}</td>
                </tr>${detailRow}`;
            }).join('');
        }

//@fn renderOrdersTab
function renderOrdersTab() {
            poRefreshFormLists();
            renderOrdersList();
        }

//@fn renderOrdersIfOpen
function renderOrdersIfOpen() {
            const tab = document.getElementById('orders-tab');
            if (!tab || !tab.classList.contains('active')) return;
            poRefreshFormLists();
            renderOrdersList();
            // A sync can deliver a status change made on another device while the arrival dialog is open.
            const modal = document.getElementById('orders-arrive-modal');
            if (modal && modal.style.display === 'flex') {
                const o = purchaseOrders.find(x => x.id === poState().arriveOrderId);
                if (!poIsOpen(o)) poCloseArriveModal();
            }
        }

//@fn poMarkInTransit
function poMarkInTransit(orderId) {
            const o = purchaseOrders.find(x => x.id === orderId && !x.removed);
            if (!o || o.status !== 'pending') return;
            const nowIso = new Date().toISOString();
            o.status = 'in_transit';
            o.statusHistory = (o.statusHistory || []).concat([{ status: 'in_transit', at: nowIso, by: poActor() }]);
            poSave();
            renderOrdersList();
            showToast(`${o.orderNo} is now In Transit.`);
        }

//@fn poCancelOrder
function poCancelOrder(orderId) {
            const o = purchaseOrders.find(x => x.id === orderId && !x.removed);
            if (!o || !poCanEdit(o)) return;
            if (!confirm(`Cancel order ${o.orderNo}? Nothing has been added to stock, and it stays on record as Cancelled.`)) return;
            o.status = 'cancelled';
            o.statusHistory = (o.statusHistory || []).concat([{ status: 'cancelled', at: new Date().toISOString(), by: poActor() }]);
            poSave();
            renderOrdersList();
            showToast(`${o.orderNo} cancelled.`);
        }

//@fn poRemoveOrder
function poRemoveOrder(orderId) {
            // A tombstone, not a splice: the sync server merges by id and treats "missing" as "unchanged",
            // so a deleted record must exist as a newer record marked removed, or it would come back.
            const o = purchaseOrders.find(x => x.id === orderId && !x.removed);
            if (!o || o.status !== 'cancelled') return;
            if (!confirm(`Remove cancelled order ${o.orderNo} from the list for good?`)) return;
            o.removed = true;
            poSave();
            renderOrdersList();
            showToast(`${o.orderNo} removed.`);
        }

//@fn poCloseShort
function poCloseShort(orderId) {
            const o = purchaseOrders.find(x => x.id === orderId && !x.removed);
            if (!poIsOpen(o) || poOrderStats(o).receivedLines === 0) return;
            const left = o.items.filter(it => poLineOutstanding(it) > 0).length;
            if (!confirm(`Close ${o.orderNo} as complete? The ${left} item${left === 1 ? '' : 's'} still outstanding will NOT be added to stock.`)) return;
            const nowIso = new Date().toISOString();
            o.status = 'received';
            o.receivedAt = nowIso;
            o.statusHistory = (o.statusHistory || []).concat([{ status: 'received', at: nowIso, by: poActor() }]);
            poSave();
            renderOrdersList();
            showToast(`${o.orderNo} closed.`);
        }

//@fn poOpenArriveModal
function poOpenArriveModal(orderId) {
            const o = purchaseOrders.find(x => x.id === orderId && !x.removed);
            if (!poIsOpen(o)) return;
            const st = poState();
            st.arriveOrderId = o.id;
            st.arriveBusy = false;
            st.arriveLines = {};
            o.items.forEach(it => {
                const left = poLineOutstanding(it);
                if (left > 0) st.arriveLines[it.id] = { checked: true, qty: String(left) };
            });
            const expense = document.getElementById('po-arrive-expense-check');
            if (expense) expense.checked = true;
            document.getElementById('po-arrive-msg').textContent = '';
            poRenderArriveModal();
            document.getElementById('orders-arrive-modal').style.display = 'flex';
        }

//@fn poCloseArriveModal
function poCloseArriveModal() {
            const modal = document.getElementById('orders-arrive-modal');
            if (modal) modal.style.display = 'none';
            const st = poState();
            st.arriveOrderId = null;
            st.arriveLines = {};
        }

//@fn poRenderArriveModal
function poRenderArriveModal() {
            const st = poState();
            const o = purchaseOrders.find(x => x.id === st.arriveOrderId);
            if (!o) return;
            document.getElementById('po-arrive-title').textContent = `📦 Confirm Arrival — ${o.orderNo}`;
            document.getElementById('po-arrive-summary').textContent =
                `${o.supplierName || 'No supplier'} · ordered ${poFormatDateTime(o.createdAt)}`;
            const tbody = document.querySelector('#po-arrive-table tbody');
            tbody.innerHTML = o.items.map(it => {
                const left = poLineOutstanding(it);
                if (left <= 0) {
                    return `<tr class="po-arrive-done"><td></td><td>${escapeHtml(it.name)}</td><td colspan="3">✅ Already received</td></tr>`;
                }
                const s = st.arriveLines[it.id] || { checked: false, qty: String(left) };
                const lid = escapeJsAttr(it.id);
                const prices = [];
                if (it.retailPrice != null) prices.push(`Retail ${money(it.retailPrice)}`);
                if (it.wholesalePrice != null) prices.push(`Wholesale ${money(it.wholesalePrice)}`);
                const product = poFindProduct(it.code, it.name);
                const priceText = prices.length
                    ? `Saves: ${prices.join(' · ')}`
                    : (product ? 'Selling prices unchanged' : '⚠️ No retail price given — set one in Inventory after');
                return `<tr>
                    <td><input type="checkbox" ${s.checked ? 'checked' : ''} onchange="poArriveToggleLine('${lid}', this.checked)" aria-label="Arrived"></td>
                    <td>${escapeHtml(it.name)}<div class="po-sub">${escapeHtml(priceText)} · cost ${money(it.cost)}/unit</div></td>
                    <td data-label="Ordered">${escapeHtml(formatQtyDisplay(left, it.unit))} ${escapeHtml(unitLabel(it.unit))}</td>
                    <td data-label="Arrived now"><input type="text" inputmode="decimal" class="po-arrive-qty" id="po-arrive-qty-${escapeHtml(it.id)}" value="${escapeHtml(s.qty)}" ${s.checked ? '' : 'disabled'} oninput="poArriveQtyChange('${lid}', this.value)"></td>
                    <td data-label="Stock" id="po-arrive-stock-${escapeHtml(it.id)}"></td>
                </tr>`;
            }).join('');
            poArriveRefresh();
        }

//@fn poArriveToggleLine
function poArriveToggleLine(lineId, checked) {
            const s = poState().arriveLines[lineId];
            if (!s) return;
            s.checked = !!checked;
            const input = document.getElementById(`po-arrive-qty-${lineId}`);
            if (input) input.disabled = !checked;
            poArriveRefresh();
        }

//@fn poArriveQtyChange
function poArriveQtyChange(lineId, value) {
            const s = poState().arriveLines[lineId];
            if (!s) return;
            s.qty = value;
            poArriveRefresh();
        }

//@fn poArriveRefresh
function poArriveRefresh() {
            // Updates only the derived cells (stock before → after, expense total, confirm button) so typing
            // a quantity never re-renders — and steals focus from — the input being typed in.
            const st = poState();
            const o = purchaseOrders.find(x => x.id === st.arriveOrderId);
            if (!o) return;
            let total = 0, picked = 0;
            o.items.forEach(it => {
                const s = st.arriveLines[it.id];
                const cell = document.getElementById(`po-arrive-stock-${it.id}`);
                if (!s) return;
                const qty = parseQtyInput(s.qty);
                const valid = s.checked && qty > 0;
                if (valid) { total += qty * (Number(it.cost) || 0); picked++; }
                if (!cell) return;
                const product = poFindProduct(it.code, it.name);
                if (!s.checked) { cell.textContent = 'Not arrived yet'; return; }
                if (!(qty > 0)) { cell.textContent = 'Enter a quantity'; return; }
                cell.innerHTML = product
                    ? `${escapeHtml(formatQtyDisplay(product.qty || 0, product.unit || it.unit))} → <strong>${escapeHtml(formatQtyDisplay((Number(product.qty) || 0) + qty, product.unit || it.unit))}</strong>`
                    : '🆕 New product';
            });
            const amountEl = document.getElementById('po-arrive-expense-amount');
            if (amountEl) amountEl.textContent = money(total);
            const confirmBtn = document.getElementById('po-arrive-confirm-btn');
            if (confirmBtn) confirmBtn.disabled = picked === 0;
        }

//@fn poApplyArrivedLine
function poApplyArrivedLine(order, item, qty) {
            // Commits one arrived line to inventory. Same rules and the same stock-movement logging as the
            // Restock tab (the server reconciles quantities from that log, so it must not be skipped).
            // NB: this codebase stores an item's BUYING price in `wholesalePrice` and its wholesale SELLING
            // price in `wholesaleSellingPrice`; `price` is the retail price.
            const code = String(item.code || '').trim();
            const name = String(item.name || '').trim() || code;
            const cost = Number(item.cost) || 0;
            const retail = item.retailPrice == null ? NaN : Number(item.retailPrice);
            const wholesale = item.wholesalePrice == null ? NaN : Number(item.wholesalePrice);
            const reason = `Order ${order.orderNo} received`;
            const product = poFindProduct(code, name);
            if (product) {
                logStockMovement(product.code, product.name, qty, reason);
                // An app whose stock model needs more than `qty +=` (e.g. Pharmacy's batches) defines
                // poCustomStockIn locally and returns true once it has added the stock itself.
                const handled = (typeof poCustomStockIn === 'function') && poCustomStockIn(product, qty);
                if (!handled) product.qty = (Number(product.qty) || 0) + qty;
                product.wholesalePrice = cost;
                if (retail > 0) product.price = retail;
                if (wholesale > 0) product.wholesaleSellingPrice = wholesale;
                return { created: false };
            }
            const created = {
                type: 'item',
                code: code || generateItemCode(),
                name,
                price: retail > 0 ? retail : cost,
                wholesaleSellingPrice: wholesale > 0 ? wholesale : 0,
                wholesalePrice: cost,
                qty,
                unit: item.unit || 'pcs',
                location: '',
                vatCategory: 'A',
                expiryDate: null,
                image: null,
            };
            inventory.push(created);
            logStockMovement(created.code, created.name, qty, `${reason} (new product)`);
            return { created: true };
        }

//@fn poConfirmArrival
function poConfirmArrival() {
            const st = poState();
            if (st.arriveBusy) return;
            const o = purchaseOrders.find(x => x.id === st.arriveOrderId && !x.removed);
            const msgEl = document.getElementById('po-arrive-msg');
            if (!poIsOpen(o)) { poCloseArriveModal(); renderOrdersList(); return; }

            const picks = [];
            for (const it of o.items) {
                const s = st.arriveLines[it.id];
                if (!s || !s.checked) continue;
                const qty = parseQtyInput(s.qty);
                if (!(qty > 0)) { msgEl.textContent = `Enter how many "${it.name}" arrived.`; return; }
                picks.push({ item: it, qty });
            }
            if (picks.length === 0) { msgEl.textContent = 'Tick at least one item that has arrived.'; return; }

            st.arriveBusy = true;   // a double-tap must never add the stock twice
            const recordExpense = document.getElementById('po-arrive-expense-check').checked;
            let total = 0, newProducts = 0;
            const applied = [];
            try {
                picks.forEach(({ item, qty }) => {
                    const r = poApplyArrivedLine(o, item, qty);
                    if (r.created) newProducts++;
                    item.receivedQty = poRound3((Number(item.receivedQty) || 0) + qty);
                    total += qty * (Number(item.cost) || 0);
                    applied.push(item);
                });
            } catch (e) {
                // Whatever was applied before the failure is already in inventory, so it must still be saved
                // and recorded on the order; only the failing line (and any after it) is left outstanding.
                console.error('Order arrival failed part-way:', e);
                showToast('Something went wrong adding one of the items — the rest is saved. Check the order and try again.', true);
                if (applied.length === 0) { st.arriveBusy = false; return; }
            }

            const nowIso = new Date().toISOString();
            const complete = o.items.every(it => poLineOutstanding(it) <= 0);
            o.statusHistory = (o.statusHistory || []).slice();
            if (complete) {
                o.status = 'received';
                o.receivedAt = nowIso;
                o.statusHistory.push({ status: 'received', at: nowIso, by: poActor() });
            } else {
                if (o.status === 'pending') o.status = 'in_transit';
                o.statusHistory.push({ status: 'partial', at: nowIso, by: poActor() });
            }

            safeSetItem('pos_inventory', JSON.stringify(inventory));
            if (recordExpense && total > 0) {
                expenses.push({
                    id: genSaleId(),
                    timestamp: nowIso,
                    category: 'Restock',
                    description: `Order ${o.orderNo}${o.supplierName ? ' from ' + o.supplierName : ''} — ${applied.length} item${applied.length === 1 ? '' : 's'} received`,
                    amount: total,
                    auto: true,
                });
                saveExpenses();
            }
            poSave();   // also queues the sync push that carries the inventory + stock-movement changes

            poCloseArriveModal();
            renderInventoryTable();
            renderNotifications();
            if (typeof checkPendingExchangeReminders === 'function') checkPendingExchangeReminders();
            renderOrdersList();
            showToast(complete
                ? `✅ ${o.orderNo} received — stock updated${newProducts ? ` (${newProducts} new product${newProducts === 1 ? '' : 's'} created)` : ''}.`
                : `📦 ${applied.length} item${applied.length === 1 ? '' : 's'} from ${o.orderNo} added to stock — the rest is still outstanding.`);
        }

//@fn applyPriceSelectTier
function applyPriceSelectTier(targetPrice) {
            const code = interactivePricingItemCode;
            if (!code) return;
            const key = cartKeyFor(code, undefined);
            const beforeQty = currentCart[key] ? currentCart[key].qty : 0;
            addToCart(code, undefined);
            const afterQty = currentCart[key] ? currentCart[key].qty : 0;
            if (afterQty <= beforeQty) return; // addToCart declined (e.g. out of stock) — its own toast already explained why
            if (typeof targetPrice === 'number') changeCartPrice(key, targetPrice);
            closePriceSelectModal();
        }

//@fn attendanceRosterList
function attendanceRosterList() {
            // POS staff are free entries here — no duplicate record needed.
            // Roster entries are the extra non-POS people added in Settings.
            const fromStaff = staff.filter(s => !s.removed).map(s => ({ key: `staff:${s.id}`, name: s.name, hasPin: false }));
            const fromRoster = attendanceRoster.map(r => ({ key: `roster:${r.id}`, name: r.name, hasPin: !!r.pin }));
            return [...fromStaff, ...fromRoster].sort((a, b) => a.name.localeCompare(b.name));
        }

//@fn buildBillOwedMessage
function buildBillOwedMessage(customerName, owedAmount) {
            // paymentAccounts doesn't exist in every app (Hotel/Hospital
            // never had that feature) — guarded so this can't throw a
            // silent ReferenceError that gets swallowed by the caller's
            // try/catch, which is exactly what happened here originally.
            const hasPaymentAccounts = typeof paymentAccounts !== 'undefined' && Array.isArray(paymentAccounts) && paymentAccounts.length > 0;
            const paymentLine = hasPaymentAccounts
                ? `Pay via: ${paymentAccounts.map(a => a.name).join(', ')}`
                : `Pay via M-Pesa or cash`;
            return `Hello ${customerName || 'there'}, you have an outstanding balance of KES ${owedAmount.toFixed(2)} at ${businessName || 'us'}. ${paymentLine}. Thank you!`;
        }

//@fn buildReceiptEscPosBytes
function buildReceiptEscPosBytes(headerText, itemsText, footerText) {
            const itemAlignByte = receiptItemAlign === 'center' ? 1 : receiptItemAlign === 'right' ? 2 : 0; // justified -> left, same reasoning as buildEscPosBytes above

            const headerLines = headerText.replace(/\r/g, '').split('\n');
            const headerChunks = headerLines.map((line, i) => i === 0 ? ESCPOS.boldLine(line) : ESCPOS.text(line));

            const itemLines = itemsText.replace(/\r/g, '').split('\n');
            const itemChunks = itemLines.map(line => /^\s*(TOTAL|AMOUNT DUE TODAY|DUE NOW|ITEM\s+QTY)\b/.test(line) ? ESCPOS.boldLine(line) : ESCPOS.text(line));

            return ESCPOS.concat([
                ESCPOS.INIT,
                ESCPOS.justify(1), ...headerChunks,
                ESCPOS.justify(itemAlignByte), ...itemChunks,
                ESCPOS.justify(1), ESCPOS.text(footerText),
                ...(receiptRefBarcodeBytes(footerText) ? [ESCPOS.text(''), receiptRefBarcodeBytes(footerText)] : []),   // scannable Ref barcode
                ESCPOS.FEED3, ESCPOS.CUT,
            ]);
        }

//@fn cellLooksLikeCurrency
function cellLooksLikeCurrency(raw) {
            return CURRENCY_MARKER_RE.test(String(raw || ''));
        }

//@fn closeChangeStaffPinModal
function closeChangeStaffPinModal() {
            document.getElementById('change-staff-pin-modal').style.display = 'none';
            changeStaffPinTargetId = null;
        }

//@fn closePinSetConfirmModal
function closePinSetConfirmModal() {
            document.getElementById('pin-set-confirm-modal').style.display = 'none';
        }

//@fn closeSearchPriceChoice
function closeSearchPriceChoice() {
            const portal = document.getElementById('search-price-choice-portal');
            if (portal) portal.style.display = 'none';
        }

//@fn collapseTabsIfNeeded
function collapseTabsIfNeeded() {
            const nav = document.querySelector('nav.tabs');
            const moreBtn = document.getElementById('tabs-more-btn');
            const moreMenu = document.getElementById('tabs-more-menu');
            if (!nav || !moreBtn || !moreMenu || TAB_MASTER_ORDER.length === 0) return;

            // Reset first: every tab button back into the nav bar, in master order,
            // before measuring anything. This is what makes a fresh measurement
            // meaningful — a button pulled out of the overflow menu picks up the
            // nav bar's own padding/font-size again immediately.
            TAB_MASTER_ORDER.forEach(id => {
                const btn = document.querySelector(`.tab-link[data-tab="${id}"]`);
                if (btn) { btn.style.maxWidth = ''; nav.insertBefore(btn, moreBtn); }
            });
            moreMenu.innerHTML = '';

            const widthOf = {};
            TAB_MASTER_ORDER.forEach(id => {
                const btn = document.querySelector(`.tab-link[data-tab="${id}"]`);
                widthOf[id] = btn ? btn.offsetWidth : 0;
            });

            const activeId = currentActiveTabId();
            // Kept in sync with .tabs-more-btn's CSS min-width (90px) plus a small
            // margin — under-reserving here would mean the "More" button itself
            // could get clipped by .tabs's overflow:hidden right when it's needed.
            // Measured when it is showing (its label and padding differ per app / screen size): a fixed guess let it stick out a few
            // pixels past the edge of a phone (zip 125).
            const MORE_BTN_WIDTH = moreBtn.offsetWidth ? moreBtn.offsetWidth + 8 : 100;
            // The bar's own side padding is not room for tabs (counting it let "More" stick out past the edge of a phone). (zip 125)
            const navCs = getComputedStyle(nav);
            const available = nav.clientWidth - (parseFloat(navCs.paddingLeft) || 0) - (parseFloat(navCs.paddingRight) || 0) - 2;

            // Greedy fit in master (declared) order.
            let used = 0;
            const fitting = [];
            for (let i = 0; i < TAB_MASTER_ORDER.length; i++) {
                const id = TAB_MASTER_ORDER[i];
                const w = widthOf[id] || 0;
                const remaining = TAB_MASTER_ORDER.length - i - 1;
                const reserve = remaining > 0 ? MORE_BTN_WIDTH : 0;
                if (used + w + reserve <= available || fitting.length === 0) {
                    // Always keep at least one tab visible even on a truly tiny screen.
                    used += w;
                    fitting.push(id);
                } else {
                    break;
                }
            }

            // The active tab must always be visible. If the greedy pass left it out,
            // evict from the end of the fitting set (lowest priority) until there's
            // room, then add it back in its natural master-order position.
            if (!fitting.includes(activeId) && TAB_MASTER_ORDER.includes(activeId)) {
                const activeWidth = widthOf[activeId] || 0;
                // Evict down to NOTHING if need be (was: down to one tab) — keeping one extra tab next to a long-named active one
                // pushed the "More" button past the right edge of a small phone, where it could not be tapped at all (zip 122).
                while (fitting.length > 0 && used + activeWidth + MORE_BTN_WIDTH > available) {
                    const evicted = fitting.pop();
                    used -= widthOf[evicted] || 0;
                }
                fitting.push(activeId);
                used += activeWidth;
                // Still too wide on its own: the active tab's label is shortened (…) so "More" always stays on screen.
                const activeBtn = document.querySelector(`.tab-link[data-tab="${activeId}"]`);
                if (activeBtn && activeWidth + MORE_BTN_WIDTH > available && available > MORE_BTN_WIDTH + 40) {
                    activeBtn.style.maxWidth = (available - MORE_BTN_WIDTH) + 'px';
                    activeBtn.style.overflow = 'hidden';
                    activeBtn.style.textOverflow = 'ellipsis';
                }
            }

            const fittingSet = new Set(fitting);
            // Render in master order regardless of the order things were added above.
            const visibleIds = TAB_MASTER_ORDER.filter(id => fittingSet.has(id));
            const overflowIds = TAB_MASTER_ORDER.filter(id => !fittingSet.has(id));

            visibleIds.forEach(id => {
                const btn = document.querySelector(`.tab-link[data-tab="${id}"]`);
                if (btn) nav.insertBefore(btn, moreBtn);
            });

            if (overflowIds.length === 0) {
                moreBtn.style.display = 'none';
                moreMenu.classList.remove('show');
                moreMenu.innerHTML = '';
            } else {
                moreBtn.style.display = 'inline-flex';
                overflowIds.forEach(id => {
                    const btn = document.querySelector(`.tab-link[data-tab="${id}"]`);
                    if (btn) moreMenu.appendChild(btn);
                });
            }
        }

//@fn commitRecipeCaptureReview
function commitRecipeCaptureReview() {
            const errEl = document.getElementById('recipe-review-error');
            errEl.textContent = '';
            if (!recipeCaptureState || recipeCaptureState.dishes.length === 0) {
                errEl.textContent = 'Nothing to save.';
                return;
            }

            let dishesSaved = 0, ingredientsCreated = 0;
            const problems = [];

            recipeCaptureState.dishes.forEach(dish => {
                const dishName = (dish.dishName || '').trim();
                const yieldQty = parseFloat(dish.yieldQty);
                if (!dishName) { problems.push('A dish is missing a name — skipped.'); return; }
                if (!yieldQty || yieldQty <= 0) { problems.push(`"${dishName}": needs a yield greater than 0 — skipped.`); return; }
                const validIngredients = dish.ingredients.filter(i => (i.name || '').trim() && parseFloat(i.qty) > 0);
                if (validIngredients.length === 0) { problems.push(`"${dishName}": has no usable ingredient rows — skipped.`); return; }

                const recipeRows = validIngredients.map(ing => {
                    let code = ing.matchedCode;
                    if (!code) {
                        // Might already have been created a moment ago by an
                        // earlier dish in this SAME batch — e.g. "Beef" used
                        // by both a Pilau and a Beef Stew recipe. The initial
                        // match (openRecipeCaptureReviewModal) only checked
                        // inventory as it stood BEFORE this capture started,
                        // so two dishes both introducing "Beef" for the first
                        // time used to each create their OWN separate stock
                        // item — two disconnected "Beef" counts that a
                        // restock or a sale of either dish never kept in
                        // sync. Re-checking inventory here (which by now
                        // includes anything already pushed by an earlier
                        // dish in this same forEach) makes "Beef" a single,
                        // shared ingredient that every dish's recipe draws
                        // from — each dish still reduces it by its own
                        // qtyPerUnit, so the deduction itself stays
                        // per-dish, only the underlying stock is unified.
                        const normalizedName = ing.name.trim().toLowerCase();
                        const alreadyCreated = inventory.find(p => isRecipeComponent(p) && p.name.trim().toLowerCase() === normalizedName);
                        if (alreadyCreated) {
                            code = alreadyCreated.code;
                            if (parseFloat(ing.unitCost) > 0) alreadyCreated.wholesalePrice = parseFloat(ing.unitCost);
                        } else {
                            code = genSaleId();
                            inventory.push({
                                code, type: 'ingredient', name: ing.name.trim(),
                                price: 0, wholesaleSellingPrice: 0,
                                wholesalePrice: parseFloat(ing.unitCost) || 0,
                                qty: 0, unit: normalizeCapturedUnit(ing.unit),
                                location: '', vatCategory: 'A',
                            });
                            ingredientsCreated++;
                        }
                    } else if (parseFloat(ing.unitCost) > 0) {
                        const existing = inventory.find(p => p.code === code);
                        if (existing) existing.wholesalePrice = parseFloat(ing.unitCost);
                    }
                    const totalQty = parseFloat(ing.qty) || 0;
                    return { code, qtyPerUnit: totalQty / yieldQty };
                });

                const existingDish = inventory.find(p => p.type === 'service' && p.name.trim().toLowerCase() === dishName.toLowerCase());
                const sellingPrice = parseFloat(dish.sellingPrice) || 0;
                if (existingDish) {
                    existingDish.recipe = recipeRows;
                    existingDish.comboItems = null;
                    if (sellingPrice > 0) existingDish.price = sellingPrice;
                } else {
                    inventory.push({
                        code: genSaleId(), type: 'service', name: dishName,
                        price: sellingPrice, wholesalePrice: 0, wholesaleSellingPrice: 0,
                        unit: 'pcs', qty: null, location: '', image: null,
                        vatCategory: 'A', recipe: recipeRows, comboItems: null,
                    });
                }
                dishesSaved++;
            });

            if (dishesSaved === 0) {
                errEl.textContent = problems.join(' ') || 'Nothing valid to save.';
                return;
            }

            safeSetItem('pos_inventory', JSON.stringify(inventory));
            queuePush();
            renderInventoryTable();
            if (typeof renderServicesTable === 'function') renderServicesTable();
            closeRecipeCaptureReviewModal();
            showToast(`${dishesSaved} recipe(s) saved${ingredientsCreated > 0 ? ` — ${ingredientsCreated} new ingredient(s) added with 0 stock, restock them from Inventory` : ''}.${problems.length ? ' ' + problems.join(' ') : ''}`);
        }

//@fn confirmBillSettle
function confirmBillSettle(skipReceipt) {
            // skipReceipt = "Save (no receipt)": the payment is recorded exactly the same, but no receipt is shown or printed.
            return confirmBillSettleImpl(!!skipReceipt);
        }

//@fn copyPinSetConfirmValue
function copyPinSetConfirmValue() {
            const input = document.getElementById('pin-set-confirm-value');
            input.select();
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(input.value);
            } else {
                document.execCommand('copy');
            }
            showToast('PIN copied.');
        }

//@fn currentOfferTargets
function currentOfferTargets() {
            return Array.from(document.querySelectorAll('#offer-target-picker [data-target-checkbox]:checked')).map(el => {
                return el.dataset.kind === 'category' ? { kind: 'category', category: el.dataset.value } : { kind: 'code', code: el.dataset.value };
            });
        }

//@fn detectCsvColumnsAI
async function detectCsvColumnsAI(rows) {
            const aiAbort = new AbortController();
            const aiTimer = setTimeout(() => aiAbort.abort(), 8000);        // a slow AI call must not hold the import up: the offline column detection takes over
            try {
                const headerRow = rows[0] || [];
                const sampleRows = rows.slice(1, 9);
                if (headerRow.length === 0 && sampleRows.length === 0) return null;

                const res = await fetch(apiUrl('/api/ai-capture-list'), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ inventoryColumns: { headerRow, sampleRows } }),
                    signal: aiAbort.signal,
                });
                const data = await res.json();
                if (!res.ok || !data || typeof data.mapping !== 'object') return null;

                const m = data.mapping;
                const at = (v) => (Number.isInteger(v) && v >= 0) ? v : -1;
                if (at(m.name) === -1 && at(m.code) === -1) return null; // nothing usable — let the offline tiers try

                return {
                    headerIsData: !!data.header_is_data,
                    mapping: {
                        name: at(m.name), code: at(m.code), category: at(m.category),
                        price: at(m.price), wholesaleSelling: at(m.wholesaleSelling), wholesale: at(m.wholesale),
                        qty: at(m.qty), unit: at(m.unit), location: at(m.location), vat: at(m.vat),
                        expiry: at(m.expiry), dual: at(m.dual), unitsPerBox: at(m.unitsPerBox),
                        piecePrice: at(m.piecePrice), pieceWholesale: at(m.pieceWholesale), image: at(m.image),
                    },
                };
            } catch (err) {
                return null; // network hiccup / AI Capture List not enabled — offline tiers take over
            } finally {
                clearTimeout(aiTimer);
            }
        }

//@fn editBillDueDate
function editBillDueDate(billId) {
            const bill = bills.find(b => b.id === billId);
            if (!bill) return;
            const raw = prompt('Due date (YYYY-MM-DD), or leave blank to clear:', bill.dueDate || '');
            if (raw === null) return;
            const val = raw.trim();
            if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
                showToast('Enter the date as YYYY-MM-DD, e.g. 2026-09-30.', true);
                return;
            }
            bill.dueDate = val || null;
            // A new/changed due date should be free to alert again even if
            // today already fired one for the old date.
            delete bill.lastDueSoonReminderDate;
            delete bill.lastOverdueReminderDate;
            safeSetItem('pos_bills', JSON.stringify(bills));
            queuePush();
            renderBillsTab();
            showToast(val ? `Due date set to ${formatShortDate(val)}.` : 'Due date cleared.');
        }

//@fn etimsLogPeriodRange
function etimsLogPeriodRange() {
            const activeBtn = document.querySelector('#etims-log-period-filter-bar .item-filter-btn.active');
            const preset = activeBtn ? activeBtn.dataset.period : 'daily';

            if (preset === 'weekly') {
                // Sunday through today (not a rolling 7-day window), same as the rest of the app.
                const today = new Date();
                const from = new Date(today);
                from.setDate(today.getDate() - today.getDay());
                return { preset, from: dateKey(from), to: dateKey(today) };
            }
            if (preset === 'monthly') {
                const monthPicker = document.getElementById('etims-log-month-picker');
                if (monthPicker && !monthPicker.value) monthPicker.value = todayDateString().slice(0, 7);
                const [y, m] = (monthPicker ? monthPicker.value : todayDateString().slice(0, 7)).split('-').map(Number);
                const first = new Date(y, m - 1, 1);
                const last = new Date(y, m, 0);
                return { preset, from: dateKey(first), to: dateKey(last) };
            }
            if (preset === 'custom') {
                const fromEl = document.getElementById('etims-log-date-from');
                const toEl = document.getElementById('etims-log-date-to');
                if (fromEl && !fromEl.value) fromEl.value = todayDateString();
                if (toEl && !toEl.value) toEl.value = fromEl ? fromEl.value : todayDateString();
                const fromVal = fromEl ? fromEl.value : todayDateString();
                const toVal = toEl ? toEl.value : fromVal;
                return fromVal <= toVal ? { preset, from: fromVal, to: toVal } : { preset, from: toVal, to: fromVal };
            }
            // daily (default)
            const picker = document.getElementById('etims-log-date-picker');
            if (picker && !picker.value) picker.value = todayDateString();
            const dateVal = picker ? picker.value : todayDateString();
            return { preset, from: dateVal, to: dateVal };
        }

//@fn genSaleId
function genSaleId() {
            // 10 random characters (zip 131): two tills that make a sale in the same millisecond must never share an id (the server
            // merges sales by id, so one would silently replace the other).
            let r = '';
            try { const b = new Uint32Array(2); crypto.getRandomValues(b); r = b[0].toString(36).padStart(7, '0').slice(-6) + b[1].toString(36).padStart(7, '0').slice(-4); } catch (e) { /* older browser */ }
            if (r.length < 10) r = (Math.random().toString(36).slice(2, 8) + '000000').slice(0, 6) + (Math.random().toString(36).slice(2, 6) + '0000').slice(0, 4);
            return `${Date.now()}-${r}`;
        }

//@fn generateRandomStaffPin
function generateRandomStaffPin() {
            const pin = String(Math.floor(1000 + Math.random() * 9000));
            document.getElementById('change-staff-pin-input').value = pin;
            document.getElementById('change-staff-pin-confirm-input').value = pin;
        }

//@fn importInventoryCsv
function importInventoryCsv(file) {
            if (!file) return;
            showBusyBanner(`⏳ Reading "${file.name}"… please wait — a big file or a slow connection can take up to a minute.`);
            const ext = fileExt(file.name);

            if (ext === 'xlsx' || ext === 'xls') {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        showBusyBanner('⏳ Loading the Excel reader… (needs internet the first time — please wait)');
                        await nextPaint();
                        await loadSheetJs();
                        showBusyBanner('⏳ Reading the rows…');
                        await nextPaint();
                        const workbook = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
                        const sheet = workbook.Sheets[workbook.SheetNames[0]];
                        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
                            .map(r => r.map(c => (c === null || c === undefined) ? '' : String(c)));
                        beginInventoryFileImport(rows, file.name);
                    } catch (err) {
                        hideBusyBanner();
                        showToast(err.message || 'Could not read that Excel file.', true);
                    }
                };
                reader.onerror = () => { hideBusyBanner(); showToast('Could not read that file.', true); };
                reader.readAsArrayBuffer(file);
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                let rows;
                try {
                    rows = parseCsvText(String(e.target.result));
                } catch (err) {
                    hideBusyBanner();
                    showToast('Could not read that file — is it a valid CSV/Excel export?', true);
                    return;
                }
                beginInventoryFileImport(rows, file.name);
            };
            reader.onerror = () => { hideBusyBanner(); showToast('Could not read that file.', true); };
            reader.readAsText(file);
        }

//@fn invertStoreImportSelection
function invertStoreImportSelection() {
            document.querySelectorAll('.store-import-check').forEach(cb => { cb.checked = !cb.checked; });
        }

//@fn levenshteinDistance
function levenshteinDistance(a, b) {
            const m = a.length, n = b.length;
            if (!m) return n;
            if (!n) return m;
            const dp = new Array(n + 1);
            for (let j = 0; j <= n; j++) dp[j] = j;
            for (let i = 1; i <= m; i++) {
                let prev = dp[0];
                dp[0] = i;
                for (let j = 1; j <= n; j++) {
                    const tmp = dp[j];
                    dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
                    prev = tmp;
                }
            }
            return dp[n];
        }

//@fn loadStoreLog
async function loadStoreLog(forceRefresh) {
            if (!myBranchGroupId) return [];
            if (!forceRefresh && storeLogCache.length > 0) return storeLogCache;
            try {
                const res = await fetch(apiUrl('/api/store'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'getLog' }),
                });
                const data = await res.json();
                if (!res.ok || data.error) return [];
                storeLogCache = data.log || [];
                return storeLogCache;
            } catch (e) {
                return [];
            }
        }

//@fn onBarcodeLinkChange
function onBarcodeLinkChange() {
            const select = document.getElementById('barcode-link-select');
            const valueInput = document.getElementById('barcode-value-input');
            const autogenBtn = document.getElementById('barcode-autogen-btn');
            const hintEl = document.getElementById('barcode-value-hint');
            const code = select.value;
            if (!code) {
                if (autogenBtn) autogenBtn.style.display = '';
                if (hintEl) hintEl.textContent = 'Letters, numbers, spaces, dashes and periods only.';
                return;
            }
            const product = inventory.find(p => p.code === code);
            if (!product) return;
            // A dual-unit item's scannable code is its Piece code, not its
            // main (box) code — same distinction addBarcodeToSheet() makes
            // when actually saving.
            const existingValue = product.dualUnit ? (product.pieceCode || product.code) : product.code;
            valueInput.value = sanitizeBarcodeValue(existingValue);
            // Auto-Generate would hand this item a brand-new random code —
            // the opposite of "print a label for the code it already has" —
            // so it's hidden while linked rather than left sitting there
            // inviting a mistake.
            if (autogenBtn) autogenBtn.style.display = 'none';
            hintEl.textContent = `Using "${product.name}"'s existing code — clear/edit the value above if you'd rather give it a different one instead.`;
            previewBarcode();
        }

//@fn onOfferTypeChange
function onOfferTypeChange() {
            const type = document.getElementById('offer-type-select').value;
            ['bogo', 'percent', 'flat', 'bundle'].forEach(t => {
                document.getElementById(`offer-fields-${t}`).style.display = t === type ? 'block' : 'none';
            });
        }

//@fn openBarcodeScanModal
async function openBarcodeScanModal(onResult) {
            scanModalOnResult = onResult;
            const modal = document.getElementById('barcode-scan-modal');
            modal.style.display = 'flex';
            document.getElementById('barcode-scan-manual-input').value = '';
            document.getElementById('barcode-scan-torch-btn').style.display = 'none';
            setBarcodeScanModalStatus('Starting camera…');

            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                setBarcodeScanModalStatus('Camera not available on this device/browser — type the code below instead.');
                return;
            }

            // Same fallback chain as the background scanner (exact rear
            // camera → any rear camera → lower resolution → any camera at
            // all), with one more rung here: a device with only a front
            // camera (a laptop webcam, mainly) still gets a working scanner
            // instead of a dead end, since this modal — unlike the
            // background service — is something the person is actively
            // looking at and can just angle the barcode differently for.
            const videoConstraintAttempts = [
                { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, advanced: [{ focusMode: 'continuous' }] },
                { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, advanced: [{ focusMode: 'continuous' }] },
                { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
                { facingMode: 'environment' },
                { facingMode: 'user' },
                true,
            ];
            let stream = null;
            for (const constraints of videoConstraintAttempts) {
                try {
                    stream = await navigator.mediaDevices.getUserMedia({ video: constraints });
                    break;
                } catch (e) { /* try next */ }
            }
            if (!stream) {
                setBarcodeScanModalStatus('Camera unavailable — permission denied, or no camera found. Type the code below instead.');
                return;
            }

            scanModalStream = stream;
            const video = document.getElementById('barcode-scan-video');
            video.srcObject = stream;

            const [track] = stream.getVideoTracks();
            scanModalTrack = track || null;
            if (track && track.getCapabilities) {
                try {
                    const caps = track.getCapabilities();
                    if (caps.focusMode && caps.focusMode.includes('continuous')) {
                        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
                    }
                    scanModalTorchSupported = !!caps.torch;
                } catch (e) { /* device doesn't honor this — still works, just without it */ }
            }
            document.getElementById('barcode-scan-torch-btn').style.display = scanModalTorchSupported ? 'inline-block' : 'none';

            if (!('BarcodeDetector' in window)) {
                setBarcodeScanModalStatus('Live scanning isn\'t supported on this browser — type the code below instead.');
                return;
            }
            try {
                scanModalDetector = new BarcodeDetector({
                    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'codabar', 'itf', 'qr_code'],
                });
            } catch (e) {
                scanModalDetector = new BarcodeDetector();
            }

            scanModalCanvas = document.createElement('canvas');
            scanModalCanvasCtx = scanModalCanvas.getContext('2d', { willReadFrequently: true });
            scanModalLastValue = '';
            scanModalLastTime = 0;
            setBarcodeScanModalStatus('Point the camera at the barcode — it fills in automatically.');
            scanModalIntervalId = setInterval(() => runScanModalTick(video), 180);
        }

//@fn openSearchPriceChoice
function openSearchPriceChoice(code, anchorEl) {
            const product = inventory.find(p => p.code === code);
            if (!product) return;
            const portal = document.getElementById('search-price-choice-portal');

            portal.innerHTML = `
                <div style="padding:8px 12px; cursor:pointer; font-size:13px;" onclick="addToCart('${escapeJsAttr(code)}'); closeSearchPriceChoice();">Retail — KES ${(Number(product.price) || 0).toFixed(2)}</div>
                <div style="padding:8px 12px; cursor:pointer; font-size:13px; border-top:1px solid var(--light);" onclick="addToCart('${escapeJsAttr(code)}', undefined, 'wholesale'); closeSearchPriceChoice();">Wholesale — KES ${(product.wholesaleSellingPrice || 0).toFixed(2)}</div>
            `;

            const rect = anchorEl.getBoundingClientRect();
            const menuWidth = 180;
            let left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
            let top = rect.bottom + 4;
            if (top + 80 > window.innerHeight - 8) top = rect.top - 80 - 4;

            portal.style.left = `${left}px`;
            portal.style.top = `${top}px`;
            portal.style.display = 'block';
        }

//@fn performRestoreBackup
async function performRestoreBackup(date) {
            try {
                const res = await fetch(apiUrl('/api/backups'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ date }),
                });
                const data = await res.json();
                if (!res.ok || !data.restored) throw new Error(data.error || 'restore failed');
                showToast(`Restored to ${date}. Reloading…`);
                // A full reload is the simplest way to guarantee every piece of local
                // state (dozens of separate variables/localStorage keys) picks up the
                // restored data consistently, rather than trying to hand-patch each one.
                setTimeout(() => window.location.reload(), 1200);
            } catch (e) {
                showToast(`Could not restore that backup: ${e.message}`, true);
            }
        }

//@fn printReceipt
async function printReceipt() {
            // ONE print per tap, and one per receipt. A second tap while the first is still going (the old Print button stayed open and was easy to hit
            // twice, especially with auto-print on) used to queue a second copy. Now: taps during a print are ignored; a receipt that was already
            // printed asks before printing another copy; and when the print worked the preview closes, so there is nothing left to tap twice.
            if (window.__receiptPrinting) return;
            const sale = currentReceiptSale;
            if (sale && sale.printedAt) {
                const at = new Date(sale.printedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                if (!confirm(`This receipt was already printed at ${at}. Print another copy?`)) return;
            }
            window.__receiptPrinting = true;
            window.__lastPrintOk = null;                                   // set to false by the USB / Bluetooth printers when a print fails
            try {
                // A receipt is only printed for a sale that is durably saved (zip 127): on this device, in its journal, or on the server.
                // The journal write takes milliseconds; only a device whose storage is full AND has no journal is ever asked.
                if (sale && sale.id != null && typeof window.salesJournalDurable === 'function') {
                    const d = await window.salesJournalDurable(sale.id);
                    if (d.tracked && !d.local && !d.journal && !d.server
                        && !confirm('This sale could NOT be saved on this device (its storage is full). It is being sent to the server — keep the app open until the sync dot is green.\n\nPrint the receipt anyway?')) return;
                }
                await queuePrintJob(printReceiptJob);
                if (window.__lastPrintOk === false) return;                // failed: the printer already said so; the preview stays for another try
                markReceiptPrinted(sale);
                try { if (sale && typeof window.salesJournalMarkPrinted === 'function') window.salesJournalMarkPrinted(sale.id); } catch (e) { /* bookkeeping */ }
                closeReceiptAfterPrint();
            } catch (e) {
                showToast('The receipt could not be printed. Try again.', true);
            } finally {
                window.__receiptPrinting = false;
            }
        }

//@fn markReceiptPrinted
function markReceiptPrinted(sale) {
            // Remembers on the sale itself (so every till knows) that its receipt has been printed, and how many times.
            if (!sale || !sale.id) return;
            const stored = (typeof salesLog !== 'undefined' && salesLog.find((s) => s && s.id === sale.id)) || (typeof bills !== 'undefined' && bills.find((b) => b && b.id === sale.id));
            if (!stored) return;
            const now = new Date().toISOString();
            stored.printedAt = now; stored.printCount = (stored.printCount || 0) + 1;
            sale.printedAt = now; sale.printCount = stored.printCount;
            if (typeof salesLog !== 'undefined' && salesLog.includes(stored)) safeSetItem('pos_sales_log', JSON.stringify(salesLog));
            else if (typeof bills !== 'undefined') safeSetItem('pos_bills', JSON.stringify(bills));
            queuePush();
        }

//@fn printStoreReport
async function printStoreReport() {
            const items = await loadStoreItems();
            const searchEl = document.getElementById('store-search-input');
            const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
            const filtered = (q
                ? items.filter(it => it.name.toLowerCase().includes(q) || _codeMatches(it.code, q))
                : items
            ).slice().sort((a, b) => a.name.localeCompare(b.name));

            const rows = filtered.length === 0
                ? `<tr><td colspan="4" class="empty-state">The store is empty.</td></tr>`
                : filtered.map(it => `
                    <tr>
                        <td>${escapeHtml(it.name)}</td>
                        <td>${it.code ? escapeHtml(it.code) : '—'}</td>
                        <td>${formatQtyDisplay(it.qty, it.unit)} ${unitLabel(it.unit)}</td>
                        <td>KES ${(it.price || 0).toFixed(2)}</td>
                    </tr>`).join('');

            document.getElementById('sales-report-body').innerHTML = `
                <h2 style="text-align:center;">${escapeHtml(businessName || 'Business POS')}</h2>
                <h3 style="text-align:center; margin-top:0;">Store List${q ? ' (filtered)' : ''} — ${new Date().toLocaleString('en-GB')}</h3>
                <table>
                    <thead><tr><th>Item</th><th>Code</th><th>In Store</th><th>Price</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            `;

            const sep = '-'.repeat(getPaperCols());
            const textLines = [
                (businessName || 'Business POS').toUpperCase(),
                `Store List${q ? ' (filtered)' : ''} - ${new Date().toLocaleString('en-GB')}`,
                sep,
            ];
            if (filtered.length === 0) {
                textLines.push('The store is empty.');
            } else {
                filtered.forEach(it => {
                    textLines.push(`${it.name}${it.code ? ' (#' + it.code + ')' : ''}`);
                    textLines.push(`  ${formatQtyDisplay(it.qty, it.unit)}${unitLabel(it.unit)} @ KES ${(it.price || 0).toFixed(2)}`);
                });
            }
            lastReportText = textLines.join('\n');

            document.getElementById('sales-report-modal').style.display = 'flex';
            triggerAutoPrintReport();
        }

//@fn profitReportRange
function profitReportRange() {
            const activeBtn = document.querySelector('#profit-period-filter-bar .item-filter-btn.active');
            const preset = activeBtn ? activeBtn.dataset.period : 'daily';

            if (preset === 'weekly') {
                // Sunday through today (not a rolling 7-day window) — resets each Sunday.
                const today = new Date();
                const from = new Date(today);
                from.setDate(today.getDate() - today.getDay());
                return { preset, from: dateKey(from), to: dateKey(today) };
            }
            if (preset === 'monthly') {
                const monthPicker = document.getElementById('profit-month-picker');
                if (monthPicker && !monthPicker.value) monthPicker.value = todayDateString().slice(0, 7);
                const [y, m] = (monthPicker ? monthPicker.value : todayDateString().slice(0, 7)).split('-').map(Number);
                const first = new Date(y, m - 1, 1);
                const last = new Date(y, m, 0);
                return { preset, from: dateKey(first), to: dateKey(last) };
            }
            if (preset === 'custom') {
                const fromEl = document.getElementById('profit-date-from');
                const toEl = document.getElementById('profit-date-to');
                if (fromEl && !fromEl.value) fromEl.value = todayDateString();
                if (toEl && !toEl.value) toEl.value = fromEl ? fromEl.value : todayDateString();
                const fromVal = fromEl ? fromEl.value : todayDateString();
                const toVal = toEl ? toEl.value : fromVal;
                return fromVal <= toVal ? { preset, from: fromVal, to: toVal } : { preset, from: toVal, to: fromVal };
            }
            // daily (default)
            const picker = document.getElementById('profit-date-picker');
            if (picker && !picker.value) picker.value = todayDateString();
            const dateVal = picker ? picker.value : todayDateString();
            return { preset, from: dateVal, to: dateVal };
        }

//@fn readImageAsScaledDataUrl
function readImageAsScaledDataUrl(file, maxW, maxH) {
            return new Promise((resolve, reject) => {
                if (!file) { reject(new Error('No file selected.')); return; }
                if (!/^image\//.test(file.type)) { reject(new Error('That file isn’t an image.')); return; }

                const reader = new FileReader();
                reader.onerror = () => reject(new Error('Could not read that file.'));
                reader.onload = () => {
                    const img = new Image();
                    img.onerror = () => reject(new Error('Could not open that image.'));
                    img.onload = () => {
                        const scale = Math.min(1, maxW / img.width, maxH / img.height);
                        const w = Math.max(1, Math.round(img.width * scale));
                        const h = Math.max(1, Math.round(img.height * scale));
                        const canvas = document.createElement('canvas');
                        canvas.width = w;
                        canvas.height = h;
                        const ctx = canvas.getContext('2d');
                        // White backing: transparent PNGs otherwise come out as black
                        // blocks once flattened for printing.
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, w, h);
                        ctx.drawImage(img, 0, 0, w, h);
                        resolve(canvas.toDataURL('image/png'));
                    };
                    img.src = reader.result;
                };
                reader.readAsDataURL(file);
            });
        }

//@fn renderAllBranchSwitchers
function renderAllBranchSwitchers() {
            const selects = document.querySelectorAll('.branch-scope-switcher');
            if (!selects.length) return;
            const allowed = branchSwitchingAllowed();
            if (!allowed) viewedBranchId = 'self'; // belt-and-braces — never leave a staff view mid-scan
            selects.forEach(sel => {
                const wrap = sel.closest('.branch-scope-bar');
                if (wrap) wrap.style.display = allowed ? 'flex' : 'none';
                if (!allowed) return;
                const data = branchesSummaryCache;
                const options = ['<option value="self">📍 This Branch</option>'];
                if (data && Array.isArray(data.branches)) {
                    data.branches.filter(b => !b.isSelf).forEach(b => {
                        options.push(`<option value="${escapeHtml(b.id)}">${escapeHtml(b.label)}</option>`);
                    });
                    if (data.branches.length > 1) options.push(`<option value="all">🏢 All Branches (Combined)</option>`);
                }
                sel.innerHTML = options.join('');
                sel.value = viewedBranchId;
            });
        }

//@fn renderCode39SVG
function renderCode39SVG(rawValue, opts) {
            opts = opts || {};
            const narrow = opts.narrow || 2;
            const wide = narrow * 2.5;
            const height = opts.height || 60;
            const gap = narrow;
            // A scanner locates the start/stop pattern by first finding a run of
            // blank space on either side of the bars — without it, especially
            // when the barcode sits flush against other printed content or a
            // label edge, scans fail or are unreliable even though the bar
            // pattern itself is perfectly correct. 10x the narrow bar width is
            // the standard minimum quiet zone for Code 39.
            const quietZone = narrow * 10;

            const value = '*' + sanitizeBarcodeValue(rawValue) + '*';
            let x = quietZone;
            const bars = [];
            for (let ci = 0; ci < value.length; ci++) {
                const pattern = CODE39_TABLE[value[ci]];
                if (!pattern) continue;
                for (let i = 0; i < pattern.length; i++) {
                    const w = pattern[i] === 'W' ? wide : narrow;
                    if (i % 2 === 0) { // even indices are bars, odd indices are spaces
                        bars.push(`<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${height}" fill="black"/>`);
                    }
                    x += w;
                }
                x += gap;
            }
            const totalWidth = x + quietZone;
            return `<svg viewBox="0 0 ${totalWidth.toFixed(2)} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" style="background:white; display:block; margin:0 auto;">${bars.join('')}</svg>`;
        }

//@fn renderDeliveriesTab
function renderDeliveriesTab() {
            updateDeliveriesBadge();
            renderDeliveriesNotifList();
            const listEl = document.getElementById('deliveries-order-list');
            if (!listEl) return;
            let orders = getAssignedDeliveryOrders();
            // A checked-in agent only sees their own deliveries; with no
            // one checked in (the owner's own device) every assigned
            // delivery shows, across every agent — same visibility rule
            // the rest of the app uses for owner vs worker.
            if (currentServer) orders = orders.filter(o => o.record.deliveryAgentId === `staff:${currentServer.id}`);
            if (orders.length === 0) {
                listEl.innerHTML = '<p class="empty-state" style="color:#95a5a6;">No deliveries assigned yet.</p>';
                return;
            }
            listEl.innerHTML = orders.map(({ record, source }) => {
                const status = record.deliveryStatus || 'assigned';
                const unpaid = source === 'bills';
                const agent = record.deliveryAgentId ? findDeliveryAgentById(record.deliveryAgentId) : null;
                const dd = record.deliveryDetails || {};
                return `
                <div class="delivery-order-card">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                        <b>${escapeHtml(dd.clientName || record.customerName || 'Customer')}</b>
                        <span class="delivery-status-pill ${status}">${statusLabelFor(status)}</span>
                    </div>
                    <div style="font-size:12px; color:#7f8c8d; margin-top:2px;">Ref: ${escapeHtml(record.refNumber)} — ${escapeHtml(dd.address || '')}</div>
                    ${!currentServer && agent ? `<div style="font-size:12px; color:#7f8c8d;">Agent: ${escapeHtml(agent.name)}</div>` : ''}
                    <div style="font-size:12px; color:#7f8c8d;">Total: ${money(record.total)} ${unpaid ? `<span class="delivery-pod-flag">UNPAID / POD</span>` : ''}</div>
                    <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">
                        <button class="settings-small-btn" onclick="openDeliveryOrderModal('${escapeJsAttr(record.id)}', '${source}')">📋 View Details</button>
                        ${status !== 'delivered' ? `<button class="settings-small-btn" style="background:var(--accent); color:white;" onclick="advanceDeliveryStatus('${escapeJsAttr(record.id)}', '${source}')">${nextDeliveryStatusActionLabel(status)}</button>` : ''}
                        ${unpaid ? `<button class="settings-small-btn" style="background:var(--success); color:white;" onclick="openDeliveryPaymentModal('${escapeJsAttr(record.id)}')">💰 Record Payment</button>` : ''}
                    </div>
                </div>`;
            }).join('');
        }

//@fn renderEtimsLog
function renderEtimsLog() {
            const listEl = document.getElementById('etims-log-list');
            if (!listEl) return; // panel not on screen right now

            const range = etimsLogPeriodRange();
            const labelEl = document.getElementById('etims-log-period-label');
            if (labelEl) labelEl.textContent = etimsLogPeriodLabel(range);

            // Only sales actually attempted (kraEtimsReceiptsEnabled was on
            // at checkout) carry an etimsStatus at all — a sale made before
            // the feature was ever turned on has none, and correctly
            // doesn't show up here at all rather than as a false "failed".
            const rows = salesLog.filter(s => s.etimsStatus &&
                dayKeyOf(s.timestamp) >= range.from &&
                dayKeyOf(s.timestamp) <= range.to)
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            const counts = { submitted: 0, failed: 0, pending: 0, not_registered: 0 };
            rows.forEach(s => { if (counts[s.etimsStatus] !== undefined) counts[s.etimsStatus]++; });

            const summaryEl = document.getElementById('etims-log-summary');
            if (summaryEl) {
                summaryEl.innerHTML = Object.entries(counts).map(([key, count]) => {
                    const meta = ETIMS_STATUS_META[key];
                    return `<span style="font-size:12px; font-weight:600; padding:4px 10px; border-radius:12px; background:${meta.color}1A; color:${meta.color};">${meta.label}: ${count}</span>`;
                }).join('');
            }

            if (rows.length === 0) {
                listEl.innerHTML = '<p style="font-size:13px; color:#95a5a6;">No sales submitted to eTIMS in this period.</p>';
                return;
            }

            listEl.innerHTML = `
                <table>
                    <thead><tr><th>Time</th><th>Ref</th><th>Amount</th><th>Status</th><th>KRA Receipt</th><th></th></tr></thead>
                    <tbody>
                        ${rows.map(s => {
                            const meta = ETIMS_STATUS_META[s.etimsStatus] || { label: s.etimsStatus, color: '#95a5a6' };
                            const time = new Date(s.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                            const kraReceipt = s.etimsStatus === 'submitted' && s.etimsCurRcptNo
                                ? `${s.etimsCurRcptNo}/${s.etimsTotRcptNo || '?'}`
                                : '—';
                            const canRetry = s.etimsStatus === 'failed' || s.etimsStatus === 'pending';
                            return `<tr>
                                <td>${time}</td>
                                <td>${s.refNumber || '—'}</td>
                                <td>${money(s.total || 0)}</td>
                                <td style="color:${meta.color}; font-weight:600;">${meta.label}</td>
                                <td>${kraReceipt}</td>
                                <td>${canRetry ? `<button class="settings-small-btn" style="padding:3px 10px; font-size:12px;" onclick="retryOneEtimsSubmission('${s.id}')">Retry</button>` : ''}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>`;
        }

//@fn renderStoreLogTab
async function renderStoreLogTab() {
            const tbody = document.querySelector('#store-log-table tbody');
            if (!tbody) return;
            const log = await loadStoreLog(true);

            const searchEl = document.getElementById('store-log-search-input');
            const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
            const filtered = q
                ? log.filter(e => (e.itemName || '').toLowerCase().includes(q) || (e.servedBy || '').toLowerCase().includes(q))
                : log;

            tbody.innerHTML = log.length === 0
                ? `<tr><td colspan="5" class="empty-state">No store activity yet.</td></tr>`
                : filtered.length === 0
                ? `<tr><td colspan="5" class="empty-state">No matches.</td></tr>`
                : filtered.map(e => `
                    <tr>
                        <td>${new Date(e.timestamp).toLocaleString('en-GB')}</td>
                        <td>${STORE_LOG_ACTION_LABELS[e.action] || escapeHtml(e.action)}</td>
                        <td>${escapeHtml(e.itemName || '')}</td>
                        <td>${escapeHtml(e.detail || '')}</td>
                        <td>${escapeHtml(e.servedBy || '?')}</td>
                    </tr>`).join('');
        }

//@fn salesDatePickerValue
// The date Daily Sales shows (zip 124). It used to be filled in ONCE — when the app opened, or the first time the tab was opened —
// and never moved on: a till left open overnight kept showing yesterday, and after "jump to a receipt" or "record a past sale" it
// stayed on that old day, so a sale just made (and printed) looked missing. Now a date the APP filled in follows today (also across
// midnight); a date the person picked stays until they leave the tab (see dailySalesOpenOnToday).
function salesDatePickerValue(picker) {
            const today = todayDateString();
            if (!picker) return today;
            if (!picker.value || (picker.dataset.auto !== '0' && picker.value !== today)) { picker.value = today; picker.dataset.auto = '1'; }
            return picker.value;
        }

//@fn dailySalesOpenOnToday
// Opening the Daily Sales tab always starts on TODAY with nothing filtered out (no leftover search, "M-Pesa only" or custom range
// hiding a new sale) — and says how many of today's Pay-Later bills are in the Bills tab (they print a receipt but are not sales
// until paid). Runs just before the tab's own opening code (see the capture-phase click in the device-security block).
function dailySalesOpenOnToday() {
            try {
                ['sales-table-date-picker', 'sales-date-picker'].forEach((id) => { const p = document.getElementById(id); if (p) { p.value = todayDateString(); p.dataset.auto = '1'; } });
                const search = document.getElementById('daily-sales-search-input');
                if (search) search.value = '';
                const active = document.querySelector('#sales-table-period-filter-bar .item-filter-btn.active, #sales-period-filter-bar .item-filter-btn.active');
                if (active && active.dataset.period === 'custom') {
                    if (typeof setSalesTablePeriod === 'function') setSalesTablePeriod('daily');
                    else if (typeof setSalesPeriod === 'function') setSalesPeriod('daily');
                }
                if (typeof dailySalesMethodFilter !== 'undefined' && dailySalesMethodFilter !== 'all' && typeof setDailySalesMethodFilter === 'function') setDailySalesMethodFilter('all');
                const table = document.getElementById('daily-sales-table');
                if (table && typeof bills !== 'undefined' && Array.isArray(bills)) {
                    const today = todayDateString();
                    const n = bills.filter((b) => b && !b.voided && !b.settledAt && b.paid !== true && b.timestamp && dateKey(new Date(b.timestamp)) === today).length;
                    let note = document.getElementById('daily-sales-bills-note');
                    if (!note) { note = document.createElement('p'); note.id = 'daily-sales-bills-note'; note.className = 'settings-hint'; note.style.margin = '0 0 8px'; table.parentNode.insertBefore(note, table); }
                    note.textContent = n ? `Also today: ${n} Pay-Later bill${n === 1 ? '' : 's'} (not paid yet) — they are in the 🧾 Bills tab until paid.` : '';
                    note.style.display = n ? '' : 'none';
                }
            } catch (e) { /* the tab still opens normally */ }
        }

//@fn salesTablePeriodRange
function salesTablePeriodRange() {
            const activeBtn = document.querySelector('#sales-table-period-filter-bar .item-filter-btn.active');
            const preset = activeBtn ? activeBtn.dataset.period : 'daily';

            if (preset === 'weekly') {
                // Sunday through today (not a rolling 7-day window) — resets each Sunday.
                const today = new Date();
                const from = new Date(today);
                from.setDate(today.getDate() - today.getDay());
                return { preset, from: dateKey(from), to: dateKey(today) };
            }
            if (preset === 'monthly') {
                const monthPicker = document.getElementById('sales-table-month-picker');
                if (monthPicker && !monthPicker.value) monthPicker.value = todayDateString().slice(0, 7);
                const [y, m] = (monthPicker ? monthPicker.value : todayDateString().slice(0, 7)).split('-').map(Number);
                const first = new Date(y, m - 1, 1);
                const last = new Date(y, m, 0);
                return { preset, from: dateKey(first), to: dateKey(last) };
            }
            if (preset === 'custom') {
                const fromEl = document.getElementById('sales-table-date-from');
                const toEl = document.getElementById('sales-table-date-to');
                if (fromEl && !fromEl.value) fromEl.value = todayDateString();
                if (toEl && !toEl.value) toEl.value = fromEl ? fromEl.value : todayDateString();
                const fromVal = fromEl ? fromEl.value : todayDateString();
                const toVal = toEl ? toEl.value : fromVal;
                return fromVal <= toVal ? { preset, from: fromVal, to: toVal } : { preset, from: toVal, to: fromVal };
            }
            // daily (default)
            const dateVal = salesDatePickerValue(document.getElementById('sales-table-date-picker'));
            return { preset, from: dateVal, to: dateVal };
        }

//@fn saveRecordBillModal
function saveRecordBillModal() {
            const errEl = document.getElementById('record-bill-error');
            const customerName = (document.getElementById('record-bill-customer-name').value || '').trim();
            const phoneRaw = (document.getElementById('record-bill-phone').value || '').trim();
            const description = (document.getElementById('record-bill-description').value || '').trim();
            const amount = parseFloat(document.getElementById('record-bill-amount').value);
            const dueDate = (document.getElementById('record-bill-due-date').value || '').trim();
            const upfront = parseFloat(document.getElementById('record-bill-upfront').value) || 0;
            const upfrontMethod = document.getElementById('record-bill-upfront-method').value;

            if (!customerName) { errEl.textContent = 'Enter a customer name.'; return; }
            if (!description) { errEl.textContent = "Describe what this bill is for."; return; }
            if (!(amount > 0)) { errEl.textContent = 'Enter a total amount greater than 0.'; return; }
            if (upfront < 0) { errEl.textContent = "Amount paid now can't be negative."; return; }
            if (upfront > amount + 0.004) { errEl.textContent = "Amount paid now can't be more than the total."; return; }

            const phone = phoneRaw ? normalizeKenyanPhone(phoneRaw) : null;
            const now = new Date().toISOString();
            const bill = {
                id: genSaleId(),
                timestamp: now,
                paid: false,
                servedBy: activeServerName(),
                customerName,
                customerPhone: phone,
                items: [{ code: 'MANUAL', name: description, qty: 1, price: amount, unit: 'pcs', wholesalePrice: 0, isService: false, vatCategory: 'A' }],
                amountPaid: upfront,
                dueDate: dueDate || null,
                fulfillmentType: 'carried_immediately',
                fulfillmentStatus: 'fulfilled',
                inventoryDeducted: true,
                paymentHistory: [],
                manual: true,
            };
            if (upfront > 0) {
                bill.paymentHistory.push({ id: genSaleId(), timestamp: now, amount: upfront, method: upfrontMethod, reference: '', balanceAfter: round2(amount - upfront) });
            }
            recomputeBillStatus(bill);
            bills.push(bill);
            safeSetItem('pos_bills', JSON.stringify(bills));
            createBillNotification('new_bill', bill);
            if (phone) registerOrUpdateCustomer(phone, customerName);

            // Same "money collected right now is real revenue" pattern
            // checkoutCart() uses for its own bill-upfront payment — a
            // separate salesLog line, not folded into the bill itself.
            if (upfront > 0) {
                const upfrontRecord = {
                    id: genSaleId(),
                    timestamp: now,
                    paid: true,
                    paymentMethod: upfrontMethod,
                    servedBy: activeServerName(),
                    customerName,
                    items: [{ name: `Partial payment — Bill (${customerName})`, price: upfront, qty: 1, unit: 'payment', wholesalePrice: 0, isService: true, vatCategory: 'A' }],
                    cashAmount: upfrontMethod === 'cash' ? upfront : 0,
                    mpesaAmount: upfrontMethod === 'mpesa' ? upfront : 0,
                    cardAmount: (upfrontMethod === 'bank' || upfrontMethod === 'card') ? upfront : 0,
                    amountTendered: upfrontMethod === 'cash' ? upfront : 0,
                    change: 0,
                };
                salesLog.push(upfrontRecord);
                safeSetItem('pos_sales_log', JSON.stringify(salesLog));
            }

            queuePush();
            closeRecordBillModal();
            renderBillsTab();
            showToast('Bill recorded.');
        }

//@fn sendPendingExchangeSms
async function sendPendingExchangeSms(pending, message) {
            if (!pending.customerPhone) return;
            try {
                await fetch(apiUrl('/api/sms-send'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ to: pending.customerPhone, message }),
                });
            } catch (e) {
                // SMS is best-effort here — the POS notification (see
                // renderNotifications()) still tells staff it's ready even if
                // the text itself couldn't be sent (no SMS account set up,
                // offline, etc.).
            }
        }

//@fn setOfferScope
function setOfferScope(scope) {
            document.querySelectorAll('#offer-scope-toggle .type-toggle-btn').forEach(btn => btn.classList.remove('active'));
            const idx = scope === 'all' ? 0 : 1;
            document.querySelectorAll('#offer-scope-toggle .type-toggle-btn')[idx].classList.add('active');
            document.getElementById('offer-target-picker').style.display = scope === 'all' ? 'none' : 'block';
            document.getElementById('offer-target-picker').dataset.scope = scope;
        }

//@fn setStoreImportSelection
function setStoreImportSelection(checked) {
            document.querySelectorAll('.store-import-check').forEach(cb => { cb.checked = checked; });
        }

//@fn showPinSetConfirmModal
function showPinSetConfirmModal(name, pin) {
            document.getElementById('pin-set-confirm-text').textContent = `${name}'s new PIN — share it with them now:`;
            document.getElementById('pin-set-confirm-value').value = pin;
            document.getElementById('pin-set-confirm-modal').style.display = 'flex';
        }

//@fn stopCaptureListCamera
function stopCaptureListCamera() {
            if (captureListStream) {
                captureListStream.getTracks().forEach(t => t.stop());
                captureListStream = null;
            }
            const wrapper = document.getElementById('capture-list-camera-wrapper');
            if (wrapper) wrapper.style.display = 'none';
            document.getElementById('capture-source-modal').classList.remove('capture-camera-active');
        }

//@fn submitChangeStaffPin
function submitChangeStaffPin() {
            const errEl = document.getElementById('change-staff-pin-error');
            const member = staff.find(s => s.id === changeStaffPinTargetId);
            if (!member) { errEl.textContent = 'Staff member not found.'; return; }
            const newPin = document.getElementById('change-staff-pin-input').value;
            const confirmPin = document.getElementById('change-staff-pin-confirm-input').value;
            if (newPin.length < 4) { errEl.textContent = 'PIN must be at least 4 characters.'; return; }
            if (newPin !== confirmPin) { errEl.textContent = 'The two PINs don’t match.'; return; }

            closeChangeStaffPinModal();
            pendingChangeStaffPinId = member.id;
            pendingChangeStaffPinValue = newPin;
            adminPwModalPurpose = 'change-staff-pin';
            showAdminPwModal(
                'Management Access',
                `Enter the management password to change ${member.name}'s PIN`,
                `No management password is set yet. Create one now to protect staff PIN changes.`
            );
        }

//@fn toggleRecipeBuilder
function toggleRecipeBuilder() {
            const checked = document.getElementById('inv-has-recipe').checked;
            document.getElementById('recipe-builder').style.display = checked ? 'block' : 'none';
            if (checked && recipeDraft.length === 0) {
                addRecipeRow();
            } else {
                renderRecipeRows();
            }
            // A service is either made from ingredients OR a combo of other services/items,
            // not both — keeping this simple avoids "what happens when a combo item
            // is itself a recipe service that ALSO has its own top-level recipe" cases.
            if (checked) {
                const comboBox = document.getElementById('inv-is-combo');
                if (comboBox && comboBox.checked) {
                    comboBox.checked = false;
                    toggleComboBuilder();
                }
            }
        }

//@fn toggleTabsOverflowMenu
function toggleTabsOverflowMenu(evt) {
            if (evt) evt.stopPropagation();
            const menu = document.getElementById('tabs-more-menu');
            const btn = document.getElementById('tabs-more-btn');
            if (!menu || !btn) return;

            const opening = !menu.classList.contains('show');
            if (opening) {
                // Anchor it to wherever the "More" button actually is right now —
                // needed every time since it's position:fixed (see the CSS comment
                // on .tabs-more-menu) and has no parent-relative percentage to fall
                // back on.
                const rect = btn.getBoundingClientRect();
                menu.style.top = `${rect.bottom}px`;
                menu.style.right = `${Math.max(0, window.innerWidth - rect.right)}px`;
                menu.style.left = 'auto';
            }
            menu.classList.toggle('show');
        }

//@fn updateCaptureReviewField
function updateCaptureReviewField(id, field, value) {
            const it = captureReviewState.items.find(i => i.id === id);
            if (!it) return;
            it[field] = value;
            // Deliberately no re-render here — a full renderCaptureReviewTable()
            // would blow away whatever input the person is mid-typing into.
            // The red "missing value" highlight simply catches up the next
            // time the table redraws (e.g. after a match dropdown change).
        }

//@fn updateStoreItemField
async function updateStoreItemField(storeItemId, field, value) {
            try {
                const res = await fetch(apiUrl('/api/store'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'updateFields', storeItemId, fields: { [field]: value }, servedBy: activeServerName() }),
                });
                const data = await res.json();
                if (!res.ok || data.error) { showToast(data.error || 'Could not update that item.', true); renderStoreTab(); return; }
                storeItemsCache = data.items;
                renderStoreTab();
            } catch (e) {
                showToast(netErrText('Could not reach the server'), true);
                renderStoreTab();
            }
        }

//@fn updateStoreItemQty
async function updateStoreItemQty(storeItemId, value) {
            const qty = parseFloat(value);
            if (isNaN(qty) || qty < 0) { showToast('Enter a valid quantity.', true); renderStoreTab(); return; }

            try {
                const res = await fetch(apiUrl('/api/store'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'setQty', storeItemId, qty, servedBy: activeServerName() }),
                });
                const data = await res.json();
                if (!res.ok || data.error) { showToast(data.error || 'Could not update that item.', true); renderStoreTab(); return; }
                storeItemsCache = data.items;
                renderStoreTab();
            } catch (e) {
                showToast(netErrText('Could not reach the server'), true);
                renderStoreTab();
            }
        }
//@fn hwKey
function hwKey(name) {
            // Per-app storage key for a remembered-printer detail ("pos_bt_printer_id", or "aqua_bt_printer_id" in Aqua POS).
            return usbPrinterNameKey().replace('usb_printer_name', name);
        }

//@fn hwStatus
function hwStatus(kind, cls, text) {
            const el = document.getElementById(kind === 'usb' ? 'usb-printer-status' : 'bluetooth-printer-status');
            if (!el) return;
            // Only replace what is empty or was written by the connection code itself. A specific message from someone pressing Connect
            // ("Access denied — Windows already has the printer...") stays until they act on it.
            window.__hwOwnStatus = window.__hwOwnStatus || {};
            const cur = el.textContent || '';
            const routine = !cur || cur === window.__hwOwnStatus[kind] || /^(Not connected|Last connected|Printer unplugged|Printer disconnected|Found |Looking for|Connected:|Choose your printer|Connecting to)/.test(cur);
            if (!routine) return;
            el.className = 'settings-msg' + (cls ? ' ' + cls : '');
            el.textContent = text;
            window.__hwOwnStatus[kind] = text;
        }

//@fn hwIsReady
function hwIsReady(kind) {
            try {
                if (kind === 'usb') return !!(usbPrinterDevice && usbPrinterEndpoint !== null && usbPrinterDevice.opened !== false);
                return !!(btPrinterCharacteristic && btPrinterDevice && btPrinterDevice.gatt && btPrinterDevice.gatt.connected);
            } catch (e) { return false; }
        }

//@fn hwWithTimeout
function hwWithTimeout(promise, ms) {
            // A printer that has stopped answering (switched off mid-job, out of range) can leave a write pending for ever, which would block
            // every later print behind it. Give each write a time limit.
            let timer;
            const limit = new Promise((_, reject) => {
                timer = setTimeout(() => { const e = new Error('The printer did not respond.'); e.name = 'TimeoutError'; e.hwTimeout = true; reject(e); }, ms || window.__hwWriteMs || 15000);
            });
            return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
        }

//@fn hwSingleFlight
function hwSingleFlight(kind, fn) {
            // Reconnecting is one thing at a time: the background loop, a "print" that finds the printer gone, and the browser's own
            // "plugged back in" event may all ask at once, and two attempts at the same device would fight each other.
            window.__hwFlights = window.__hwFlights || {};
            if (window.__hwFlights[kind]) return window.__hwFlights[kind];
            const p = Promise.resolve().then(fn).catch(() => false).finally(() => { window.__hwFlights[kind] = null; });
            window.__hwFlights[kind] = p;
            return p;
        }

//@fn hwUsbReconnect
function hwUsbReconnect() {
            return hwSingleFlight('usb', async () => {
                if (!navigator.usb) return false;
                if (hwIsReady('usb')) return true;
                if (usbPrinterDevice) { usbPrinterDevice = null; usbPrinterEndpoint = null; }      // a stale handle from before the power cut
                const devices = await navigator.usb.getDevices();
                if (!devices.length) return false;
                const idOf = (d) => [d.vendorId, d.productId, d.serialNumber || ''].join(':');
                const savedId = localStorage.getItem(hwKey('usb_printer_id'));
                const savedName = localStorage.getItem(usbPrinterNameKey());
                // Only the printer that was used last. If it is not attached right now (switched off, unplugged) nothing else is claimed:
                // another permitted USB device (a scanner, a scale) must never be mistaken for it. With nothing remembered yet, take the first.
                let device = (savedId && devices.find((d) => idOf(d) === savedId)) || (savedName && devices.find((d) => d.productName === savedName)) || null;
                if (!device && !savedId && !savedName) device = devices[0];
                if (!device) return false;
                try {
                    hwStatus('usb', '', `Found ${device.productName || 'the printer'} — connecting…`);
                    await claimUsbPrinterEndpoint(device, document.getElementById('usb-printer-status'));
                } catch (e) { return false; }                                                        // still starting up, or held by another program: tried again
                if (!hwIsReady('usb')) return false;
                safeSetItem(hwKey('usb_printer_id'), idOf(device));
                return true;
            });
        }

//@fn hwBtFindCharacteristic
async function hwBtFindCharacteristic(server) {
            for (const uuid of BT_PRINTER_SERVICE_UUIDS) {
                try {
                    const service = await server.getPrimaryService(uuid);
                    const characteristics = await service.getCharacteristics();
                    const found = characteristics.find((c) => c.properties.write || c.properties.writeWithoutResponse);
                    if (found) return found;
                } catch (e) { /* not on this device: next */ }
            }
            return null;
        }

//@fn hwBtAttach
async function hwBtAttach(device) {
            // gatt.connect() can hang for a printer that is off or out of range, so it gets a time limit.
            let timer;
            const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), window.__hwBtConnectMs || 12000); });
            let server;
            try { server = await Promise.race([device.gatt.connect(), limit]); }
            catch (e) { try { device.gatt.disconnect(); } catch (e2) { /* nothing to close */ } return false; }
            finally { clearTimeout(timer); }
            let characteristic = null;
            try { characteristic = await hwBtFindCharacteristic(server); } catch (e) { characteristic = null; }
            if (!characteristic) { try { device.gatt.disconnect(); } catch (e) { /* nothing to close */ } return false; }
            btPrinterDevice = device;
            btPrinterCharacteristic = characteristic;
            safeSetItem(hwKey('bt_printer_name'), device.name || 'Bluetooth printer');
            if (device.id) safeSetItem(hwKey('bt_printer_id'), device.id);
            if (!device.__hwHooked) {
                device.__hwHooked = true;
                device.addEventListener('gattserverdisconnected', () => { btPrinterCharacteristic = null; if (typeof hwKick === 'function') hwKick(1500); });
            }
            return true;
        }

//@fn hwBtWatch
function hwBtWatch(device) {
            // Some browsers can tell us the moment a remembered printer starts advertising (it was just switched on): connect then, not on the next poll.
            if (device.__hwWatching || typeof device.watchAdvertisements !== 'function') return;
            device.__hwWatching = true;
            try {
                device.addEventListener('advertisementreceived', () => { if (!hwIsReady('bt') && typeof hwKick === 'function') hwKick(150); });
                Promise.resolve(device.watchAdvertisements()).catch(() => { device.__hwWatching = false; });
            } catch (e) { device.__hwWatching = false; }
        }

//@fn hwBtReconnect
function hwBtReconnect() {
            return hwSingleFlight('bt', async () => {
                if (!navigator.bluetooth) { window.__hwBtReason = 'unsupported'; return false; }
                if (hwIsReady('bt')) return true;
                let device = btPrinterDevice;                                        // this page already knows the printer: reopen it, no chooser
                if (!device && typeof navigator.bluetooth.getDevices === 'function') {    // after a reload: the printers this browser remembers
                    const list = await navigator.bluetooth.getDevices();
                    const savedId = localStorage.getItem(hwKey('bt_printer_id')), savedName = localStorage.getItem(hwKey('bt_printer_name'));
                    device = (savedId && list.find((d) => d.id === savedId)) || (savedName && list.find((d) => d.name === savedName)) || null;
                }
                if (!device) { window.__hwBtReason = typeof navigator.bluetooth.getDevices === 'function' ? 'unknown' : 'needs-pairing'; return false; }
                window.__hwBtReason = 'off';
                hwBtWatch(device);
                return hwBtAttach(device);
            });
        }

//@fn hwEnsureReady
async function hwEnsureReady(kind, ms) {
            // Called when something is about to print: the printer may simply have been switched on a moment ago, so look for it (up to ms)
            // before giving up with "no printer connected".
            if (hwIsReady(kind)) return true;
            const limit = ms || window.__hwReadyMs || 4000;
            const t0 = Date.now();
            for (;;) {
                const ok = kind === 'usb' ? await hwUsbReconnect() : await hwBtReconnect();
                if (ok) return true;
                if (Date.now() - t0 + 700 > limit) return false;
                await new Promise((r) => setTimeout(r, 700));
            }
        }

//@fn hwLinkLost
function hwLinkLost(e) {
            const name = e && e.name, msg = String((e && e.message) || '');
            return name === 'NotFoundError' || name === 'InvalidStateError' || name === 'NetworkError'
                || /disconnected|no device|not connected|must be opened|unavailable/i.test(msg);
        }

//@fn hwWrapPrinting
function hwWrapPrinting() {
            if (window.__hwWrapped) return;
            window.__hwWrapped = true;
            const k = () => window.__hwKeeper;
            const busy = async (fn) => { k().printing++; try { return await fn(); } finally { k().printing--; } };
            ['usb', 'bt'].forEach((kind) => {
                const printName = kind === 'usb' ? 'printViaUSB' : 'printViaBluetooth';
                const sendName = kind === 'usb' ? 'sendBytesViaUSB' : 'sendBytesViaBluetooth';
                const origPrint = window[printName], origSend = window[sendName];
                if (typeof origPrint === 'function') {
                    // The printer was switched on a moment ago and nobody has reconnected it yet: look for it before saying "not connected".
                    window[printName] = async function (...args) {
                        if (!hwIsReady(kind)) await hwEnsureReady(kind);
                        const result = await busy(() => origPrint.apply(this, args));
                        if (result === false) window.__lastPrintOk = false;                       // printReceipt() keeps the preview open after a failed print
                        return result;
                    };
                }
                if (typeof origSend === 'function') {
                    // The link dropped just as a receipt started, before ANY byte was accepted (so nothing has been printed): reconnect and send it once
                    // more. If some of it had already gone out this is NOT repeated — that would print half a receipt twice.
                    window[sendName] = async function (bytes) {
                        if (!hwIsReady(kind)) await hwEnsureReady(kind);
                        try { return await busy(() => origSend.call(this, bytes)); }
                        catch (e) {
                            if (e && e.hwTimeout) {                                     // it stopped answering: forget the handle so the keeper reopens it; never re-send
                                if (kind === 'usb') { usbPrinterDevice = null; usbPrinterEndpoint = null; } else { btPrinterCharacteristic = null; }
                                hwKick(500);
                                throw e;
                            }
                            if (!hwLinkLost(e) || e.hwWritten !== 0) throw e;
                            if (kind === 'usb') { usbPrinterDevice = null; usbPrinterEndpoint = null; } else { btPrinterCharacteristic = null; }
                            if (!(await hwEnsureReady(kind))) throw e;
                            return busy(() => origSend.call(this, bytes));
                        }
                    };
                }
            });
        }

//@fn hwKeeperStart
function hwKeeperStart() {
            // The printer keeper. A USB or Bluetooth printer that was used last is looked for again whenever it is not connected — after the
            // power went off, the printer was switched off and on, the cable was pulled, the device went out of range or the app was reopened —
            // and connected the moment it is there, with no visit to Settings. If it is not there it keeps checking (3 s, then a little slower,
            // never slower than every 30 s). System-dialog printing has nothing to connect, so it is left alone.
            if (window.__hwKeeper) return;
            window.__hwKeeper = { fails: 0, timer: null, running: false, printing: 0, everReady: false };
            hwWrapPrinting();
            const kick = () => hwKick(200);
            document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
            window.addEventListener('focus', kick);
            window.addEventListener('online', kick);
            try { if (navigator.usb) navigator.usb.addEventListener('connect', kick); } catch (e) { /* no WebUSB here */ }
            hwKick(400);
        }

//@fn hwKick
function hwKick(delay) {
            const k = window.__hwKeeper;
            if (!k) return;
            k.fails = 0;                                        // something just changed: start looking eagerly again
            hwSchedule(delay == null ? 200 : delay);
        }

//@fn hwSchedule
function hwSchedule(ms) {
            const k = window.__hwKeeper;
            if (!k) return;
            clearTimeout(k.timer);
            k.timer = setTimeout(hwTick, ms);
        }

//@fn hwTick
async function hwTick() {
            const k = window.__hwKeeper;
            if (!k || k.running) return;
            k.running = true;
            let next = 3000;
            try {
                const mode = typeof printerMode !== 'undefined' ? printerMode : 'system';
                if (document.hidden) { next = 15000; }
                else if (mode !== 'usb' && mode !== 'bluetooth') { next = 3000; }                  // nothing to connect (or the mode is about to change)
                else if (k.printing > 0) { next = 2000; }                                          // never reconnect in the middle of a receipt
                else {
                    const kind = mode === 'usb' ? 'usb' : 'bt';
                    if ((kind === 'usb' && !navigator.usb) || (kind === 'bt' && !navigator.bluetooth)) { next = 30000; return; }      // this browser has no such API
                    const ok = kind === 'usb' ? await hwUsbReconnect() : await hwBtReconnect();
                    const was = k.lastReady === true;                                              // what the previous check found
                    const changed = k.lastReady !== !!ok;
                    k.lastReady = !!ok;
                    if (ok) {
                        k.fails = 0;
                        next = 5000;
                        // it was missing at the last check and is here now (whoever reconnected it): tell the cashier once
                        if (!was && k.everReady && typeof showToast === 'function') showToast('🖨️ Printer connected again.');
                        k.everReady = true;
                        if (kind === 'bt' && btPrinterDevice && btPrinterDevice.id && localStorage.getItem(hwKey('bt_printer_id')) !== btPrinterDevice.id) safeSetItem(hwKey('bt_printer_id'), btPrinterDevice.id);
                        if (!was) hwStatus(kind, 'success', `Connected: ${kind === 'usb' ? (usbPrinterDevice && usbPrinterDevice.productName) || 'USB printer' : (btPrinterDevice && btPrinterDevice.name) || 'Bluetooth printer'}`);
                    } else {
                        k.fails++;
                        next = Math.min(30000, Math.round(2000 * Math.pow(1.5, Math.min(k.fails, 12))));
                        const saved = localStorage.getItem(kind === 'usb' ? usbPrinterNameKey() : hwKey('bt_printer_name'));
                        if (kind === 'bt' && window.__hwBtReason === 'needs-pairing') {
                            hwStatus('bt', '', saved ? `Last connected: ${saved}. Tap Connect once — this browser can’t reopen a Bluetooth printer by itself after the page reloads.` : '');
                        } else if (saved) {
                            hwStatus(kind, '', `Looking for ${saved} — it seems to be switched off, out of range or unplugged. It will connect by itself as soon as it is back…`);
                        }
                    }
                    if (changed) {                                                                 // (not every few seconds: it also reports to the server)
                        if (typeof updatePrintRelaySectionVisibility === 'function') updatePrintRelaySectionVisibility();
                        if (typeof updateStatusDot === 'function') { try { updateStatusDot(); } catch (e) { /* the hardware block is not on this page */ } }
                    }
                }
            } catch (e) {
                next = 10000;
            } finally {
                k.running = false;
                hwSchedule(next);
            }
        }

//@fn heldSaleKey
function heldSaleKey() {
            return 'held_sale_v1:' + location.pathname;
        }

//@fn heldSaleGet
function heldSaleGet() {
            try {
                const raw = localStorage.getItem(heldSaleKey());
                const h = raw ? JSON.parse(raw) : null;
                return h && h.lines && Object.keys(h.lines).length ? h : null;
            } catch (e) { return null; }
        }

//@fn heldSalePanel
function heldSalePanel() {
            // The part of the Sales Counter that belongs to the sale in progress (cart, payment method, customer, amounts tendered...).
            const table = document.getElementById('cart-table');
            return table ? (table.closest('.panel') || table.closest('.tab-content') || document.body) : null;
        }

//@fn heldSaleFields
function heldSaleFields() {
            const panel = heldSalePanel();
            if (!panel) return [];
            return Array.from(panel.querySelectorAll('input[id], select[id], textarea[id]')).filter((el) => !/search|patient-bill|^held-|quote/i.test(el.id) && el.type !== 'file' && el.type !== 'button');
        }

//@fn holdCurrentSale
function holdCurrentSale() {
            // ONE sale can be on hold at a time: a customer who is not ready to pay while there is a queue steps aside; the cashier serves the next
            // person, then brings the held sale back with "Held" and completes it. Nothing is deducted while it waits (a held sale is just a cart).
            if (Object.keys(currentCart).length === 0) { showToast('The cart is empty — nothing to hold.', true); return false; }
            const existing = heldSaleGet();
            if (existing) { showToast('A sale is already on hold. Bring it back with "Held" first — only one can be held at a time.', true); return false; }
            const fields = {};
            heldSaleFields().forEach((el) => { fields[el.id] = el.type === 'checkbox' || el.type === 'radio' ? { c: el.checked } : { v: el.value }; });
            const total = (typeof cartTotal === 'function') ? cartTotal() : 0;
            const held = {
                savedAt: new Date().toISOString(),
                by: (typeof activeServerName === 'function') ? activeServerName() : '',
                total,
                method: typeof currentPaymentMethod !== 'undefined' ? currentPaymentMethod : null,
                lines: JSON.parse(JSON.stringify(currentCart)),
                fields,
            };
            try { localStorage.setItem(heldSaleKey(), JSON.stringify(held)); }
            catch (e) { showToast('Could not put the sale on hold (storage is full).', true); return false; }
            currentCart = {};
            // the next customer starts clean: typed amounts / names of the held sale are cleared (they come back with it)
            heldSaleFields().forEach((el) => { if (/^(text|number|tel|email|date|time)$/.test(el.type) || el.tagName === 'TEXTAREA') el.value = ''; });
            if (typeof updateChangeDue === 'function') { try { updateChangeDue(); } catch (e) { /* cosmetic */ } }
            renderCart();
            renderHeldSaleBar();
            showToast(`Sale put on hold (${Object.keys(held.lines).length} item${Object.keys(held.lines).length === 1 ? '' : 's'}, KES ${Number(total).toFixed(2)}). Serve the next customer — tap "Held" to bring it back.`);
            return true;
        }

//@fn resumeHeldSale
function resumeHeldSale() {
            const held = heldSaleGet();
            if (!held) { showToast('Nothing is on hold.', true); renderHeldSaleBar(); return false; }
            if (Object.keys(currentCart).length > 0) { showToast('Finish (or clear) the sale you are on first, then tap "Held".', true); return false; }
            currentCart = JSON.parse(JSON.stringify(held.lines));
            heldSaleFields().forEach((el) => {
                const f = held.fields && held.fields[el.id];
                if (!f) return;
                if ('c' in f) el.checked = f.c; else if ('v' in f) el.value = f.v;
            });
            if (held.method && typeof setPaymentMethod === 'function') { try { setPaymentMethod(held.method); } catch (e) { /* the method is not available in this app any more */ } }
            try { localStorage.removeItem(heldSaleKey()); } catch (e) { /* nothing */ }
            // Stock may have moved while the customer was thinking: say so, but never block.
            const short = [];
            try {
                const stock = typeof inventory !== 'undefined' && Array.isArray(inventory) ? inventory : [];      // (Aqua POS keeps products elsewhere: no check there)
                Object.values(currentCart).forEach((line) => {
                    if (line.isService) return;
                    const p = stock.find((x) => x.code === line.code);
                    if (!p || typeof getAvailableStock !== 'function') return;
                    const avail = getAvailableStock(p, line.saleMode);
                    if (avail < line.qty) short.push(`${line.name} (${avail <= 0 ? 0 : avail} left)`);
                });
            } catch (e) { /* a stock warning is an extra: never stop the sale coming back */ }
            if (typeof updateChangeDue === 'function') { try { updateChangeDue(); } catch (e) { /* cosmetic */ } }
            renderCart();
            renderHeldSaleBar();
            showToast(`Held sale is back in the cart (${Object.keys(currentCart).length} item${Object.keys(currentCart).length === 1 ? '' : 's'}) — complete it now.`);
            if (short.length) showToast('Stock has changed since it was held: ' + short.join(', ') + '.', true);
            return true;
        }

//@fn renderHeldSaleBar
function renderHeldSaleBar() {
            const table = document.getElementById('cart-table');
            if (!table) return;
            let bar = document.getElementById('held-sale-bar');
            if (!bar) {
                bar = document.createElement('div');
                bar.id = 'held-sale-bar';
                bar.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:4px 0 10px;';
                bar.innerHTML = '<button type="button" id="hold-sale-btn" class="settings-small-btn" style="background:#f39c12; color:#fff; padding:8px 14px;" onclick="holdCurrentSale()">⏸️ Hold sale</button>'
                    + '<button type="button" id="resume-held-btn" class="settings-small-btn" style="display:none; background:#8e44ad; color:#fff; padding:8px 14px;" onclick="resumeHeldSale()">▶️ Held<sup>1</sup> <span id="held-sale-info" style="font-weight:normal; font-size:12px;"></span></button>';
                const wrap = table.closest('.table-scroll') || table;
                wrap.parentNode.insertBefore(bar, wrap);
            }
            const held = heldSaleGet();
            const hold = document.getElementById('hold-sale-btn'), resume = document.getElementById('resume-held-btn');
            if (hold) { hold.disabled = !!held || Object.keys(currentCart).length === 0; hold.title = held ? 'A sale is already on hold' : 'Put this sale aside while you serve someone else'; hold.style.opacity = hold.disabled ? '0.5' : '1'; }
            if (resume) {
                resume.style.display = held ? '' : 'none';
                const info = document.getElementById('held-sale-info');
                if (held && info) info.textContent = `KES ${Number(held.total || 0).toFixed(2)} · ${new Date(held.savedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
                resume.title = held ? `${Object.keys(held.lines).length} item(s) waiting — tap to bring the sale back` : '';
            }
        }

//@fn heldSaleInstall
function heldSaleInstall() {
            if (window.__heldSaleInstalled) return;
            window.__heldSaleInstalled = true;
            if (!document.getElementById('cart-table')) return;                     // this app has no Sales Counter cart
            const orig = window.renderCart;
            if (typeof orig === 'function') {
                window.renderCart = function (...args) {
                    const r = orig.apply(this, args);
                    try { renderHeldSaleBar(); } catch (e) { /* the bar is an extra */ }
                    return r;
                };
            }
            renderHeldSaleBar();
        }

//@fn pastSalePaymentChanged
function pastSalePaymentChanged() {
            const method = (document.getElementById('past-sale-payment-select') || {}).value;
            const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? 'block' : 'none'; };
            show('past-sale-mpesa-panel', method === 'mpesa');
            show('past-sale-card-panel', method === 'card');
            show('past-sale-split-panel', method === 'split');
            show('past-sale-bill-panel', method === 'bill');
            const err = document.getElementById('past-sale-error');
            if (err) err.textContent = '';
        }

//@fn pastSalePaymentDetails
function pastSalePaymentDetails(total) {
            // Reads the payment part of the "Record a Past Sale" form. Returns { error } or { method, paid, fields, amountPaid, billName, ... }.
            const val = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
            const num = (id) => { const n = parseFloat(val(id)); return isNaN(n) ? 0 : n; };
            const r2 = (n) => Math.round(n * 100) / 100;
            const method = val('past-sale-payment-select') || 'cash';
            const base = { paymentMethod: method, paid: true, cashAmount: 0, mpesaAmount: 0, cardAmount: 0 };
            if (method === 'cash') return { method, paid: true, fields: { ...base, cashAmount: total, amountTendered: total, change: 0 } };
            if (method === 'mpesa') {
                const code = val('past-sale-mpesa-code-input').toUpperCase(), name = val('past-sale-mpesa-name-input');
                return { method, paid: true, fields: { ...base, mpesaAmount: total, ...(code ? { mpesaReceiptNumber: code } : {}), ...(name ? { mpesaPayerName: name } : {}) } };
            }
            if (method === 'card') {
                const ref = val('past-sale-card-ref-input');
                return { method, paid: true, fields: { ...base, cardAmount: total, ...(ref ? { cardReference: ref } : {}) } };
            }
            if (method === 'split') {
                const cash = num('past-sale-split-cash-input'), mpesa = num('past-sale-split-mpesa-input');
                if (cash < 0 || mpesa < 0) return { error: 'Split amounts cannot be negative.' };
                if (Math.abs(r2(cash + mpesa) - r2(total)) > 0.005) return { error: `Cash + M-Pesa must add up to the sale total (KES ${r2(total).toFixed(2)}); you have KES ${r2(cash + mpesa).toFixed(2)}.` };
                const code = val('past-sale-mpesa-code-input').toUpperCase();
                return { method, paid: true, fields: { ...base, cashAmount: cash, mpesaAmount: mpesa, amountTendered: cash, change: 0, ...(mpesa > 0 && code ? { mpesaReceiptNumber: code } : {}) } };
            }
            if (method === 'bill') {
                const name = val('past-sale-bill-name-input');
                if (!name) return { error: 'A Pay Later sale needs the customer\u2019s name.' };
                const paidNow = num('past-sale-bill-paid-input');
                if (paidNow < 0 || paidNow > total + 0.005) return { error: `The amount already paid must be between 0 and KES ${r2(total).toFixed(2)}.` };
                return { method, paid: false, billName: name, billPhone: val('past-sale-bill-phone-input'), amountPaid: r2(paidNow), upfrontMethod: val('past-sale-bill-method-select') || 'cash',
                    fields: { paymentMethod: 'bill', paid: false, cashAmount: 0, mpesaAmount: 0, cardAmount: 0, customerName: name, ...(val('past-sale-bill-phone-input') ? { customerPhone: val('past-sale-bill-phone-input') } : {}) } };
            }
            return { error: 'Choose a payment method.' };
        }

//@fn pastSaleStore
function pastSaleStore(saleRecord, payment) {
            // A paid past sale goes into the sales log, dated when it really happened. A Pay Later one goes to the Bills tab (dated the same way), and
            // anything already paid on it is recorded as its own partial payment — exactly what the Sales Counter does.
            if (!payment || payment.paid) {
                salesLog.push(saleRecord);
                safeSetItem('pos_sales_log', JSON.stringify(salesLog));
                return;
            }
            const total = saleRecord.items.reduce((s, l) => s + l.price * l.qty, 0);
            saleRecord.amountPaid = payment.amountPaid || 0;
            saleRecord.fulfillmentType = 'carried_immediately';
            saleRecord.fulfillmentStatus = 'fulfilled';
            saleRecord.inventoryDeducted = true;
            saleRecord.paymentHistory = [];
            if (saleRecord.amountPaid > 0) {
                const m = payment.upfrontMethod;
                saleRecord.paymentHistory.push({ id: genSaleId(), timestamp: saleRecord.timestamp, amount: saleRecord.amountPaid, method: m, reference: '', balanceAfter: Math.round((total - saleRecord.amountPaid) * 100) / 100 });
                salesLog.push({
                    id: genSaleId(), timestamp: saleRecord.timestamp, paid: true, paymentMethod: m, servedBy: saleRecord.servedBy, recordedLate: true,
                    customerName: payment.billName,
                    items: [{ name: `Partial payment — Bill (${payment.billName})`, price: saleRecord.amountPaid, qty: 1, unit: 'payment', wholesalePrice: 0, vatCategory: 'A' }],
                    cashAmount: m === 'cash' ? saleRecord.amountPaid : 0, mpesaAmount: m === 'mpesa' ? saleRecord.amountPaid : 0, cardAmount: m === 'card' ? saleRecord.amountPaid : 0,
                    amountTendered: m === 'cash' ? saleRecord.amountPaid : 0, change: 0,
                });
                safeSetItem('pos_sales_log', JSON.stringify(salesLog));
            }
            if (typeof recomputeBillStatus === 'function') { try { recomputeBillStatus(saleRecord); } catch (e) { /* the Bills tab recomputes on open */ } }
            bills.push(saleRecord);
            safeSetItem('pos_bills', JSON.stringify(bills));
            if (typeof createBillNotification === 'function') { try { createBillNotification('new_bill', saleRecord); } catch (e) { /* a notification is an extra */ } }
            if (document.getElementById('bills-table') && typeof renderBillsTab === 'function') { try { renderBillsTab(); } catch (e) { /* not on screen */ } }
        }

//@fn lowStockItems
function lowStockItems() {
            // Everything that is at or below the low-stock level (Settings), worst first. Services are not stock, and the "empty" half of a gas
            // cylinder is not something you order.
            const limit = typeof LOW_STOCK_THRESHOLD !== 'undefined' ? LOW_STOCK_THRESHOLD : 3;
            return inventory.filter((p) => p && p.type !== 'service' && !p.removed && !(p.isGasCylinder && p.gasRole === 'empty') && (Number(p.qty) || 0) <= limit)
                .sort((a, b) => (Number(a.qty) || 0) - (Number(b.qty) || 0) || String(a.name || '').localeCompare(String(b.name || '')))
                .slice(0, 60);
        }

//@fn lowStockInDraft
function lowStockInDraft(kind, p) {
            const same = (r) => (p.code && r.code === p.code) || (r.name && String(r.name).trim().toLowerCase() === String(p.name || '').trim().toLowerCase());
            if (kind === 'po') return poState().draft.some(same);
            return typeof restockDraft !== 'undefined' && restockDraft.some(same);
        }

//@fn renderLowStockStrip
function renderLowStockStrip(kind) {
            // "⚠️ Low stock — tap to add": one button per low item, on the Restock form and on the Orders tab. Tapping one puts it on the form
            // with the quantity box ready for you to fill in.
            const el = document.getElementById(kind === 'po' ? 'po-lowstock-chips' : 'restock-lowstock-strip');
            if (!el) return;
            if (kind !== 'po' && typeof restockDraft === 'undefined') return;
            const items = lowStockItems();
            const panel = document.getElementById('po-lowstock-panel');
            if (kind === 'po' && panel) panel.style.display = items.length ? '' : 'none';
            if (items.length === 0) { el.innerHTML = kind === 'po' ? '' : '<p class="settings-hint" style="margin:0 0 10px;">Nothing is running low right now.</p>'; return; }
            const chips = items.map((p) => {
                const added = lowStockInDraft(kind, p);
                return `<button type="button" class="lowstock-chip${added ? ' added' : ''}" ${added ? 'disabled' : ''} onclick="lowStockAdd('${kind}', '${escapeJsAttr(p.code)}')" title="${added ? 'Already on the form' : 'Add to the form'}">${escapeHtml(p.name)} <b>${formatQtyDisplay(p.qty || 0, p.unit || 'pcs')}</b> ${added ? '✓' : '➕'}</button>`;
            }).join('');
            const remaining = items.filter((p) => !lowStockInDraft(kind, p)).length;
            el.innerHTML = `<div class="lowstock-head">⚠️ Low stock <span class="settings-hint" style="margin:0;">(${items.length}) — tap one to add it, then enter the quantity</span>${remaining > 1 ? ` <button type="button" class="settings-small-btn" onclick="lowStockAddAll('${kind}')">➕ Add all (${remaining})</button>` : ''}</div><div class="lowstock-chips">${chips}</div>`;
        }

//@fn lowStockAdd
function lowStockAdd(kind, code, quiet) {
            const p = inventory.find((x) => x.code === code);
            if (!p) return;
            if (lowStockInDraft(kind, p)) return;
            let focusEl = null;
            if (kind === 'po') {
                const panel = document.getElementById('po-form-panel');
                if (panel && panel.style.display === 'none') poOpenForm();
                const st = poState();
                let row = st.draft.find((r) => !r.name.trim() && !r.code.trim() && r.qty.trim() === '' && String(r.cost).trim() === '' && r.retail === '' && r.wholesale === '');   // reuse the spare blank row
                if (!row) { row = poNewRow(); st.draft.push(row); }
                row.name = p.name; row.code = p.code || ''; row.autoCode = row.code; row.unit = p.unit || 'pcs';
                if (Number(p.wholesalePrice) > 0) row.cost = String(p.wholesalePrice);
                poRenderRows();
                focusEl = document.getElementById(`po-row-${row.rowId}-qty`);
            } else {
                const last = restockDraft[restockDraft.length - 1];
                const blank = last && !last.code && !last.name && last.qty === '' && last.cost === '';
                const row = blank ? last : { rowId: restockRowSeq++, unit: 'pcs', qty: '', cost: '', wholesaleSell: '', sellPrice: '' };
                Object.assign(row, { code: p.code || '', name: p.name, unit: p.unit || 'pcs', cost: Number(p.wholesalePrice) > 0 ? String(p.wholesalePrice) : '' });
                if (!blank) restockDraft.push(row);
                renderRestockRows();
                const rows = document.querySelectorAll('#restock-rows-tbody tr');
                const tr = rows[restockDraft.indexOf(row)];
                focusEl = tr ? tr.querySelector('input[inputmode="decimal"]') : null;
            }
            renderLowStockStrip(kind);
            if (!quiet && focusEl) { try { focusEl.focus(); if (focusEl.scrollIntoView) focusEl.scrollIntoView({ block: 'center' }); } catch (e) { /* cosmetic */ } }
        }

//@fn lowStockAddAll
function lowStockAddAll(kind) {
            lowStockItems().forEach((p) => lowStockAdd(kind, p.code, true));
            renderLowStockStrip(kind);
        }

//@fn lowStockInstall
function lowStockInstall() {
            if (window.__lowStockInstalled) return;
            window.__lowStockInstalled = true;
            const refresh = () => { try { renderLowStockStrip('po'); renderLowStockStrip('restock'); } catch (e) { /* the strips are extras */ } };
            ['restock-tab-btn', 'orders-tab-btn'].forEach((id) => { const b = document.getElementById(id); if (b) b.addEventListener('click', () => setTimeout(refresh, 60)); });
            document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
            refresh();
        }

//@fn poSupplierRecord
function poSupplierRecord(o) {
            const name = String(o.supplierName || '').trim().toLowerCase();
            return suppliers.find((s) => s && ((o.supplierId && s.id === o.supplierId) || (name && String(s.name || '').trim().toLowerCase() === name))) || null;
        }

//@fn poOrderTotal
function poOrderTotal(o) {
            return (o.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.cost) || 0), 0);
        }

//@fn poOrderText
function poOrderText(o) {
            const lines = (o.items || []).map((it) => `• ${it.name} × ${formatQtyDisplay(it.qty, it.unit)} ${unitLabel(it.unit)} @ KES ${Number(it.cost || 0).toLocaleString('en-US')}`);
            return [`*Order ${o.orderNo}* — ${typeof businessName !== 'undefined' && businessName ? businessName : 'our shop'}`, '', ...lines, '', `Total: KES ${poOrderTotal(o).toLocaleString('en-US')}`, o.note ? `Note: ${o.note}` : '', 'Please confirm availability and delivery. Thank you!'].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
        }

//@fn poSendOrder
function poSendOrder(orderId) {
            // Opens WhatsApp with the order written out, addressed to the supplier (their number is asked for once and remembered).
            const o = purchaseOrders.find((x) => x.id === orderId && !x.removed);
            if (!o) return;
            const sup = poSupplierRecord(o);
            let phone = sup && sup.phone ? String(sup.phone) : '';
            if (!phone) {
                const typed = prompt(`${o.supplierName || 'The supplier'}'s phone number (for WhatsApp) — it is saved for next time:`, '');
                if (typed === null) return;
                phone = String(typed).trim();
                if (phone && sup) { sup.phone = phone; safeSetItem('pos_suppliers', JSON.stringify(suppliers)); if (typeof renderSupplierDropdowns === 'function') renderSupplierDropdowns(); }
            }
            const norm = typeof normalizeKenyanPhone === 'function' ? normalizeKenyanPhone(phone) : phone;
            const digits = String(norm || '').replace(/\D/g, '');
            const text = poOrderText(o);
            o.sentToSupplierAt = new Date().toISOString();
            poSave();
            if (digits.length >= 9) window.open(`https://wa.me/${digits}?text=${encodeURIComponent(text)}`, '_blank');
            else if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => showToast('No valid phone number — the order text is copied, paste it into a message.'), () => {});
            else showToast('Add the supplier\u2019s phone number to send the order.', true);
            renderOrdersList();
        }

//@fn stockTakeState
function stockTakeState() {
            if (!window.__stState) window.__stState = { counts: {}, q: '', diffOnly: false };
            return window.__stState;
        }

//@fn stockTakeItems
function stockTakeItems() {
            const st = stockTakeState();
            const q = st.q.trim().toLowerCase();
            let list = inventory.filter((p) => p && p.type !== 'service' && !p.removed);
            // Flatten variants into their own countable rows — a shoe with
            // 5 sizes needs each size counted separately, not one combined
            // number for the whole item. A variant-bearing parent itself
            // isn't directly countable (its own qty is just the sum of its
            // variants', recomputed after each variant's count is applied
            // — see stockTakeApply), so it's replaced by its variants here
            // rather than listed alongside them.
            const flattened = [];
            list.forEach((p) => {
                if (p.hasVariants && Array.isArray(p.variants) && p.variants.length > 0) {
                    p.variants.forEach((v) => flattened.push(Object.assign({}, v, {
                        name: `${p.name} — ${v.name}`,
                        unit: p.unit,
                        __stCode: v.code,
                        __stParentCode: p.code,
                    })));
                } else {
                    flattened.push(Object.assign({}, p, { __stCode: p.code, __stParentCode: null }));
                }
            });
            list = flattened;
            if (q) list = list.filter((p) => String(p.name || '').toLowerCase().includes(q) || String(p.code || '').toLowerCase().includes(q));
            list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            if (st.diffOnly) list = list.filter((p) => { const d = stockTakeDiff(p); return d.qty !== 0 || d.pieces !== 0; });
            if (st.belowOnly) list = list.filter((p) => (Number(p.qty) || 0) < 0 || (Number(p.pieceQty) || 0) < 0);
            return list;
        }

//@fn stockTakeFindByCode
// Looks up a countable row by the code stockTakeItems() gave it (a plain
// item's own code, or a variant's own code) and, for a variant, also
// returns the parent product — every write-back site below needs the
// parent to resync its aggregate qty/price after the variant changes.
function stockTakeFindByCode(code) {
            const direct = inventory.find((x) => x.code === code && !(x.hasVariants && Array.isArray(x.variants) && x.variants.length > 0));
            if (direct) return { item: direct, parent: null };
            for (const p of inventory) {
                if (!p.hasVariants || !Array.isArray(p.variants)) continue;
                const v = p.variants.find((ev) => ev.code === code);
                if (v) return { item: v, parent: p };
            }
            return { item: null, parent: null };
        }

//@fn stockTakeResyncParent
// Same aggregate recompute used when a variant is edited inline from the
// Inventory table (see updateVariantField) — keeps the parent's qty/price
// consistent after a variant's own qty changes here.
function stockTakeResyncParent(parent) {
            if (!parent || !Array.isArray(parent.variants)) return;
            parent.qty = parent.variants.reduce((sum, v) => sum + v.qty, 0);
            parent.price = parent.variants.length > 0 ? Math.min(...parent.variants.map((v) => v.price)) : 0;
        }

//@fn stockTakeDiff
function stockTakeDiff(p) {
            // What was counted against what the system says (only for the fields that have a count typed in).
            const c = stockTakeState().counts[p.code] || {};
            const parse = (raw) => { if (raw === '' || raw == null) return null; const n = typeof parseQtyInput === 'function' ? parseQtyInput(String(raw)) : parseFloat(raw); return Number.isFinite(n) && n >= 0 ? n : NaN; };
            const q = parse(c.qty), pc = parse(c.pieceQty);
            const r3 = (n) => Math.round(n * 1000) / 1000;
            return {
                counted: q !== null || pc !== null,
                invalid: Number.isNaN(q) || Number.isNaN(pc),
                qtyNew: q, pieceNew: pc,
                qty: q === null || Number.isNaN(q) ? 0 : r3(q - (Number(p.qty) || 0)),
                pieces: pc === null || Number.isNaN(pc) ? 0 : r3(pc - (Number(p.pieceQty) || 0)),
            };
        }

//@fn stockTakeValueOf
function stockTakeValueOf(p, d) {
            return (d.qty * (Number(p.wholesalePrice) || 0)) + (d.pieces * (Number(p.pieceWholesalePrice) || 0));
        }

//@fn stockTakeSet
function stockTakeSet(code, field, value) {
            const st = stockTakeState();
            st.counts[code] = st.counts[code] || {};
            st.counts[code][field] = String(value).trim();
            const { item: p } = stockTakeFindByCode(code);
            if (!p) return;
            const row = Array.from(document.querySelectorAll('#stock-take-table tbody tr')).find((tr) => tr.dataset.code === code);
            if (row) stockTakeFillDiffCell(row, p);
            stockTakeRenderSummary();
        }

//@fn stockTakeFillDiffCell
function stockTakeFillDiffCell(row, p) {
            const cell = row.querySelector('.st-diff');
            if (!cell) return;
            const d = stockTakeDiff(p);
            const fmt = (n) => (n > 0 ? '+' : '') + (Math.round(n * 1000) / 1000);
            if (!d.counted) { cell.innerHTML = '<span class="st-muted">—</span>'; return; }
            if (d.invalid) { cell.innerHTML = '<span class="st-bad">Not a number</span>'; return; }
            const parts = [];
            if (d.qtyNew !== null) parts.push(`<span class="${d.qty === 0 ? 'st-ok' : d.qty < 0 ? 'st-bad' : 'st-over'}">${d.qty === 0 ? '✓ matches' : fmt(d.qty)}</span>`);
            if (d.pieceNew !== null) parts.push(`<span class="${d.pieces === 0 ? 'st-ok' : d.pieces < 0 ? 'st-bad' : 'st-over'}">${d.pieces === 0 ? '✓ loose match' : fmt(d.pieces) + ' loose'}</span>`);
            cell.innerHTML = parts.join('<br>');
        }

//@fn stockTakeRenderSummary
function stockTakeRenderSummary() {
            const el = document.getElementById('stock-take-summary');
            if (!el) return;
            const st = stockTakeState();
            let counted = 0, changed = 0, short = 0, over = 0, invalid = 0;
            Object.keys(st.counts).forEach((code) => {
                const { item: p } = stockTakeFindByCode(code);
                if (!p) return;
                const d = stockTakeDiff(p);
                if (!d.counted) return;
                counted++;
                if (d.invalid) { invalid++; return; }
                if (d.qty !== 0 || d.pieces !== 0) { changed++; const v = stockTakeValueOf(p, d); if (v < 0) short += -v; else over += v; }
            });
            const below = (typeof inventory !== 'undefined' ? inventory : []).filter((x) => x && !x.removed && x.type !== 'service' && ((Number(x.qty) || 0) < 0 || (Number(x.pieceQty) || 0) < 0)).length;
            const limitNote = `<p class="st-muted" style="margin:4px 0 0;">Missing stock worth more than <strong>KES ${stockTakeApprovalLimit().toLocaleString('en-US')}</strong> needs the management password. <a href="#" onclick="stockTakeSetApprovalLimit(prompt('Ask for the management password above what missing value (KES)? 0 = always', stockTakeApprovalLimit())); return false;">Change</a></p>`;
            const belowNote = below ? `<p class="st-bad" style="margin:4px 0 0;">⚠ ${below} item${below === 1 ? ' is' : 's are'} below zero (sold on tills that were offline at the same time) — count ${below === 1 ? 'it' : 'them'}. <a href="#" onclick="stockTakeState().belowOnly = !stockTakeState().belowOnly; renderStockTake(); return false;">${st.belowOnly ? 'Show all' : 'Show only these'}</a></p>` : '';
            const apply = document.getElementById('stock-take-apply-btn');
            if (apply) { apply.disabled = counted === 0 || invalid > 0; apply.style.opacity = apply.disabled ? '0.5' : '1'; }
            el.innerHTML = (counted === 0 ? '<p class="settings-hint" style="margin:0;">Type what you actually counted next to each item. Leave items you did not count blank — they are not touched.</p>'
                : `<p style="margin:0; font-size:14px;"><strong>${counted}</strong> counted · <strong>${changed}</strong> differ${invalid ? ` · <span class="st-bad">${invalid} not a number</span>` : ''}${short ? ` · missing stock worth <span class="st-bad">KES ${Math.round(short).toLocaleString('en-US')}</span> (at cost)` : ''}${over ? ` · extra stock worth <span class="st-over">KES ${Math.round(over).toLocaleString('en-US')}</span>` : ''}</p>`) + belowNote + limitNote;
        }

//@fn renderStockTake
function renderStockTake() {
            const tbody = document.querySelector('#stock-take-table tbody');
            if (!tbody) return;
            const st = stockTakeState();
            const list = stockTakeItems();
            if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="empty-state">${st.diffOnly ? 'No differences to show.' : 'No items match.'}</td></tr>`; stockTakeRenderSummary(); renderStockTakeHistory(); return; }
            const n = (x) => (Math.round((Number(x) || 0) * 1000) / 1000).toString();
            tbody.innerHTML = list.slice(0, 400).map((p) => {
                const c = st.counts[p.code] || {};
                const code = escapeJsAttr(p.code);
                const unit = p.unit || 'pcs';
                const dual = !!p.dualUnit;
                // zip 142 (hospitality): a bottle sold by the shot is counted as sealed bottles + the ml left in the open one (an open bottle is
                // never counted as a full one); a keg product is counted as the sealed kegs in the store (kegs on tap are measured in 🍺 Bar & Kegs)
                const bottle = !!p.bottleMl, keg = !!p.keg;
                const sys = dual ? (bottle ? `${n(p.qty)} full bottle(s) + ${n(p.pieceQty)} ml open` : `${n(p.qty)} ${escapeHtml(unitLabel(unit))} + ${n(p.pieceQty)} loose`) : keg ? `${n(p.qty)} keg(s) in the store` : `${n(p.qty)} ${escapeHtml(unitLabel(unit))}`;
                const inputs = `<input type="text" inputmode="decimal" class="st-input" placeholder="${dual ? (bottle ? 'full bottles' : 'boxes') : keg ? 'kegs in store' : 'counted'}" value="${escapeHtml(c.qty || '')}" oninput="stockTakeSet('${code}', 'qty', this.value)">`
                    + (dual ? `<input type="text" inputmode="decimal" class="st-input" placeholder="${bottle ? 'ml in open bottle' : 'loose'}" value="${escapeHtml(c.pieceQty || '')}" oninput="stockTakeSet('${code}', 'pieceQty', this.value)">` : '');
                return `<tr data-code="${escapeHtml(p.code)}"><td><strong>${escapeHtml(p.name)}</strong><div class="st-muted">${escapeHtml(p.code)}</div></td><td>${sys}</td><td class="st-inputs">${inputs}</td><td class="st-diff"></td><td style="display:flex; gap:4px; flex-wrap:wrap;"><button type="button" class="settings-small-btn st-mini" title="The count matches the system" onclick="stockTakeMatches('${code}')">✓ same</button><button type="button" class="settings-small-btn st-mini" style="background:#16a085; color:#fff;" title="Set this item's stock to the count typed above, right now — without applying anything else on this page" onclick="stockTakeApplyOne('${code}')">💾 Update</button></td></tr>`;
            }).join('') + (list.length > 400 ? `<tr><td colspan="5" class="st-muted">Showing the first 400 of ${list.length} — use the search box to narrow down.</td></tr>` : '');
            Array.from(tbody.querySelectorAll('tr[data-code]')).forEach((tr) => { const { item: p } = stockTakeFindByCode(tr.dataset.code); if (p) stockTakeFillDiffCell(tr, p); });
            stockTakeRenderSummary();
            renderStockTakeHistory();
        }

//@fn stockTakeMatches
function stockTakeMatches(code) {
            const { item: p } = stockTakeFindByCode(code);
            if (!p) return;
            const st = stockTakeState();
            st.counts[code] = { qty: String(Math.round((Number(p.qty) || 0) * 1000) / 1000) };
            if (p.dualUnit) st.counts[code].pieceQty = String(Math.round((Number(p.pieceQty) || 0) * 1000) / 1000);
            renderStockTake();
        }

//@fn stockTakeClear
function stockTakeClear() {
            stockTakeState().counts = {};
            renderStockTake();
        }

//@fn stockTakeApply
function stockTakeApply(opts) {
            const st = stockTakeState();
            const changes = [];
            let counted = 0;
            for (const code of Object.keys(st.counts)) {
                const { item: p } = stockTakeFindByCode(code);
                if (!p) continue;
                const d = stockTakeDiff(p);
                if (!d.counted) continue;
                if (d.invalid) { showToast(`"${p.name}": the count is not a number.`, true); return false; }
                counted++;
                if (d.qty !== 0 || d.pieces !== 0) changes.push({ p, d });
            }
            if (counted === 0) { showToast('Type at least one count first.', true); return false; }
            if (changes.length === 0) { showToast(`All ${counted} counts match the system — nothing to change.`); stockTakeClear(); return true; }
            const missingKes = changes.reduce((sum, { p, d }) => { const v = stockTakeValueOf(p, d); return v < 0 ? sum - v : sum; }, 0);
            if (missingKes > stockTakeApprovalLimit() && !(opts && opts.approved)) {
                requireManagementApproval(`This stock take writes off KES ${Math.round(missingKes).toLocaleString('en-US')} of missing stock (at cost). Enter the management password (or a Manager's PIN) to approve it.`, () => stockTakeApply({ approved: true }));
                return false;
            }
            if (!(opts && opts.approved) && !confirm(`Update the stock of ${changes.length} item${changes.length === 1 ? '' : 's'} to what you counted? ${counted - changes.length} counted item${counted - changes.length === 1 ? '' : 's'} already match. Each change is recorded as a "Stock take" adjustment.`)) return false;
            const lines = [];
            const touchedParents = new Set();
            // One id for this whole stock take, one immutable COUNT movement per changed figure (see stockTakeRecordCount).
            const stocktakeId = genSaleId();
            const missingValue = changes.reduce((sum, { p, d }) => { const v = stockTakeValueOf(p, d); return v < 0 ? sum - v : sum; }, 0);
            const extraValue = changes.reduce((sum, { p, d }) => { const v = stockTakeValueOf(p, d); return v > 0 ? sum + v : sum; }, 0);
            const meta = { counted, changed: changes.length, missing: Math.round(missingValue), extra: Math.round(extraValue) };
            changes.forEach(({ p, d }) => {
                const before = { qty: Number(p.qty) || 0, pieceQty: Number(p.pieceQty) || 0 };
                const { parent } = stockTakeFindByCode(p.code);
                stockTakeRecordCount(p, parent, d, stocktakeId, meta);
                if (parent) touchedParents.add(parent);
                lines.push({ code: p.code, name: p.name, unit: p.unit || 'pcs', before, after: { qty: Number(p.qty) || 0, pieceQty: Number(p.pieceQty) || 0 }, diff: d.qty, pieceDiff: d.pieces, value: Math.round(stockTakeValueOf(p, d)) });
            });
            // A counted row can be a variant, whose own qty just changed
            // above — the parent's qty (a sum of all its variants) and
            // price (the cheapest one) need the same recompute an inline
            // Inventory-table edit already gets (see updateVariantField).
            touchedParents.forEach((parent) => stockTakeResyncParent(parent));
            safeSetItem('pos_inventory', JSON.stringify(inventory));
            if (typeof stockMovementLog !== 'undefined') safeSetItem('pos_stock_movement_log', JSON.stringify(stockMovementLog));
            queuePush();
            // The history is now read from the synced stock movements themselves (every device, with the server's confirmed
            // figures) — see renderStockTakeHistory. The old per-device list is still shown for stock takes made before this.
            st.counts = {};
            if (typeof renderInventoryTable === 'function') { try { renderInventoryTable(); } catch (e) { /* not on screen */ } }
            renderStockTake();
            showToast(`Stock take applied: ${lines.length} item${lines.length === 1 ? '' : 's'} updated.`);
            return true;
        }

//@fn stockTakeApplyOne
// The per-row "💾 Update" button — sets ONE item's stock to whatever was
// typed for it, immediately, without needing to fill in every other row
// and hit the single "Apply all" button first. Deliberately no confirm()
// dialog (unlike stockTakeApply's bulk version) since a single, obviously-
// intentional row edit doesn't need the same "are you sure" friction a
// many-item bulk change does — the same reasoning an inline Inventory-
// table edit already uses.
function stockTakeApplyOne(code, opts) {
            const { item: p, parent } = stockTakeFindByCode(code);
            if (!p) return false;
            const d = stockTakeDiff(p);
            if (!d.counted) { showToast('Type a count for this item first.', true); return false; }
            if (d.invalid) { showToast(`"${p.name}": the count is not a number.`, true); return false; }
            const st = stockTakeState();
            const rowMissing = Math.max(0, -stockTakeValueOf(p, d));
            if (d.qty !== 0 || d.pieces !== 0) {
                if (rowMissing > stockTakeApprovalLimit() && !(opts && opts.approved)) {
                    requireManagementApproval(`Writing off KES ${Math.round(rowMissing).toLocaleString('en-US')} of "${p.name}" (at cost) needs the management password (or a Manager's PIN).`, () => stockTakeApplyOne(code, { approved: true }));
                    return false;
                }
            }
            if (d.qty === 0 && d.pieces === 0) {
                delete st.counts[code]; // already matches — nothing to change, just clear this row
                renderStockTake();
                showToast(`"${p.name}" already matches the system.`);
                return true;
            }
            const v = stockTakeValueOf(p, d);
            stockTakeRecordCount(p, parent, d, genSaleId(), { counted: 1, changed: 1, missing: v < 0 ? Math.round(-v) : 0, extra: v > 0 ? Math.round(v) : 0 });
            // Same parent-aggregate recompute as the bulk apply above, for
            // the case where this row is one variant of a parent item.
            if (parent) stockTakeResyncParent(parent);
            safeSetItem('pos_inventory', JSON.stringify(inventory));
            if (typeof stockMovementLog !== 'undefined') safeSetItem('pos_stock_movement_log', JSON.stringify(stockMovementLog));
            queuePush();
            delete st.counts[code]; // this row is done — clears its input box so it's obviously applied
            if (typeof renderInventoryTable === 'function') { try { renderInventoryTable(); } catch (e) { /* not on screen */ } }
            renderStockTake();
            showToast(`"${p.name}" updated.`);
            return true;
        }

//@fn requireManagementApproval
// Asks for the management password (or a Manager's PIN, where the app accepts one) and runs `then` once it is given. Uses each
// app's own password popup, so it works offline exactly like every other protected action.
function requireManagementApproval(message, then) {
            window.__adminPwCallback = then;
            if (typeof resolveAdminPwModalSuccess === 'function') { showAdminPwModal('generic-callback', message); return; }   // Aqua POS
            adminPwModalPurpose = 'generic-callback';
            showAdminPwModal('Management Access', message, 'No management password is set yet. Create one now to protect this.');
        }

//@fn stockTakeApprovalLimit
// Missing stock (at cost) above which a stock take needs the management password (#9). Default KES 5,000; 0 = always ask.
function stockTakeApprovalLimit() {
            try { const v = localStorage.getItem('pos_st_approval_kes'); if (v !== null && v !== '' && isFinite(Number(v))) return Math.max(0, Number(v)); } catch (e) { /* default */ }
            return 5000;
        }

//@fn stockTakeSetApprovalLimit
function stockTakeSetApprovalLimit(raw) {
            const n = Math.round(Number(String(raw).replace(/,/g, '')));
            if (!isFinite(n) || n < 0) { showToast('Enter an amount in KES (0 = always ask).', true); return; }
            requireManagementApproval(`Enter the management password to change the stock-take approval limit to KES ${n.toLocaleString('en-US')}.`, () => {
                try { localStorage.setItem('pos_st_approval_kes', String(n)); } catch (e) { /* not saved */ }
                if (typeof renderStockTake === 'function') { try { renderStockTake(); } catch (e) { /* not on screen */ } }
                if (typeof renderAquaStockTake === 'function') { try { renderAquaStockTake(); } catch (e) { /* not on screen */ } }
                showToast('Approval limit saved on this device.');
            });
        }

//@fn stockTakeRecordCount
// Applies one counted row on this device and records it as an ABSOLUTE count movement (logStockCount) — "there are N", not
// "+20" — so the server can never apply it as a repeated addition, and a stale device can never put the old figure back.
function stockTakeRecordCount(p, parent, d, stocktakeId, meta) {
            const name = parent ? `${parent.name} — ${p.name}` : p.name;
            const log = (unit, counted, before) => {
                const m = typeof logStockCount === 'function'
                    ? logStockCount(p, name, unit, counted, before, stocktakeId)
                    : (typeof logStockMovement === 'function' ? logStockMovement(p.code, name, counted - before, 'Stock take', unit) : null);
                if (m && meta) m.st = meta;
            };
            if (d.qtyNew !== null && d.qty !== 0) { const before = Number(p.qty) || 0; p.qty = d.qtyNew; log('qty', d.qtyNew, before); }
            if (d.pieceNew !== null && d.pieces !== 0) { const before = Number(p.pieceQty) || 0; p.pieceQty = d.pieceNew; log('pieceQty', d.pieceNew, before); }
            stockAlignBatches(p);
            p.updatedAt = Date.now();
        }

//@fn stockAlignBatches
// Batch-tracked items (pharmacy/hospital) keep qty = the sum of their batches, and a sale recomputes qty from the batches. So when a
// count changes qty, the batches follow: a shortfall comes off the soonest-expiring batch first, a surplus becomes one
// "Stock adjustment" batch. The server applies the same rule (applyStockLedger), so both sides agree.
function stockAlignBatches(p) {
            if (!p || !Array.isArray(p.batches) || p.batches.length === 0) return;
            const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
            let diff = r3((Number(p.qty) || 0) - p.batches.reduce((s, b) => s + (Number(b && b.qty) || 0), 0));
            if (diff === 0) return;
            if (diff < 0) {
                const sorted = [...p.batches].sort((a, b) => String(a.expiryDate || '9999').localeCompare(String(b.expiryDate || '9999')));
                for (const b of sorted) { if (diff >= 0) break; const take = Math.min(Number(b.qty) || 0, -diff); b.qty = r3((Number(b.qty) || 0) - take); diff = r3(diff + take); }
                p.batches = p.batches.filter((b) => (Number(b.qty) || 0) > 0);
            } else {
                p.batches.push({ id: genSaleId(), batchNumber: 'Stock adjustment', expiryDate: '9999-12-31', qty: diff });
            }
            if (p.batches.length) p.expiryDate = p.batches.reduce((mn, b) => (String(b.expiryDate) < String(mn) ? b.expiryDate : mn), p.batches[0].expiryDate);
        }

//@fn stockTakeHistoryGet
function stockTakeHistoryGet() {
            try { const h = JSON.parse(localStorage.getItem('stock_take_history_v1:' + location.pathname) || '[]'); return Array.isArray(h) ? h : []; } catch (e) { return []; }
        }

//@fn renderStockTakeHistory
function renderStockTakeHistory() {
            const el = document.getElementById('stock-take-history');
            if (!el) return;
            const synced = stockTakeHistoryFromLog();
            const hist = stockTakeHistoryGet();
            if (hist.length === 0 && synced.length === 0) { el.innerHTML = '<p class="settings-hint" style="margin:0;">No stock takes yet.</p>'; return; }
            const q = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
            const sgn = (n) => (n > 0 ? '+' : '') + q(n);
            const status = (m) => {
                if (!m._srv) return '<span class="st-muted" title="Saved on this device; the server has not confirmed it yet">⏳ waiting to sync</span>';
                if (m._srv.applied === false) return '<span class="st-bad" title="A later count of this item had already been recorded, so this one did not change the stock">⚠ superseded by a later count</span>';
                return m._srv.stale ? '<span class="st-over" title="This count was typed against an out-of-date figure; the physical count was still applied">✓ applied (figure had changed)</span>' : '<span class="st-ok">✓ applied</span>';
            };
            const syncedHtml = synced.slice(0, 8).map((g) => {
                const h = g.meta || {};
                return `<details class="st-hist"><summary>${escapeHtml(new Date(g.at).toLocaleString('en-GB'))}${g.by ? ' · ' + escapeHtml(g.by) : ''} — ${h.changed || g.lines.length} updated of ${h.counted || g.lines.length} counted${h.missing ? ` · missing KES ${Math.round(h.missing).toLocaleString('en-US')}` : ''}${h.extra ? ` · extra KES ${Math.round(h.extra).toLocaleString('en-US')}` : ''}${g.lines.some((m) => !m._srv) ? ' · ⏳' : ''}</summary>
                <div class="table-scroll"><table><thead><tr><th>Item</th><th>Was</th><th>Counted</th><th>Adjustment</th><th>Now</th><th></th></tr></thead><tbody>${g.lines.map((m) => {
                    const was = m._srv && typeof m._srv.before === 'number' ? m._srv.before : m.before;
                    const adj = m._srv ? stockMoveDelta(m) : m.delta;
                    const now = m._srv && typeof m._srv.after === 'number' ? m._srv.after : m.counted;
                    const lo = m.unit === 'pieceQty' ? ' loose' : '';
                    return `<tr><td>${escapeHtml(m.name || m.code)}</td><td>${q(was)}${lo}</td><td>${q(m.counted)}${lo}</td><td>${sgn(adj)}${lo}</td><td>${q(now)}${lo}</td><td>${status(m)}</td></tr>`;
                }).join('')}</tbody></table><div class="st-muted" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">Stock take ${escapeHtml(String(g.id))}${g.device ? ' · device ' + escapeHtml(String(g.device)) : ''}<button type="button" class="settings-small-btn st-mini" data-stid="${escapeHtml(String(g.id))}" onclick="printStockTakeReport(this.dataset.stid)">🖨️ Print</button></div></div></details>`;
            }).join('');
            if (hist.length === 0) { el.innerHTML = syncedHtml; return; }
            el.innerHTML = syncedHtml + (synced.length ? '<p class="st-muted" style="margin:8px 0 2px;">Earlier stock takes (recorded on this device only):</p>' : '') + hist.slice(0, 8).map((h) => `<details class="st-hist"><summary>${escapeHtml(new Date(h.at).toLocaleString('en-GB'))}${h.by ? ' · ' + escapeHtml(h.by) : ''} — ${h.changed} updated of ${h.counted} counted${h.missingValue ? ` · missing KES ${Math.round(h.missingValue).toLocaleString('en-US')}` : ''}${h.extraValue ? ` · extra KES ${Math.round(h.extraValue).toLocaleString('en-US')}` : ''}</summary>
                <div class="table-scroll"><table><thead><tr><th>Item</th><th>Was</th><th>Counted</th><th>Difference</th></tr></thead><tbody>${(h.lines || []).map((l) => `<tr><td>${escapeHtml(l.name)}</td><td>${Math.round(l.before.qty * 1000) / 1000}${l.pieceDiff ? ' + ' + l.before.pieceQty + ' loose' : ''}</td><td>${Math.round(l.after.qty * 1000) / 1000}${l.pieceDiff ? ' + ' + l.after.pieceQty + ' loose' : ''}</td><td>${l.diff ? (l.diff > 0 ? '+' : '') + l.diff : ''}${l.pieceDiff ? ` ${l.pieceDiff > 0 ? '+' : ''}${l.pieceDiff} loose` : ''}</td></tr>`).join('')}</tbody></table></div></details>`).join('');
        }

//@fn stockTakeHistoryFromLog
// Stock takes as recorded in the SYNCED stock movements (every device sees the same list), grouped by stock-take id, newest first.
function stockTakeHistoryFromLog() {
            const log = (typeof stockMovementLog !== 'undefined' && Array.isArray(stockMovementLog)) ? stockMovementLog : [];
            const groups = new Map();
            for (let i = log.length - 1; i >= 0; i--) {
                const m = log[i];
                if (!m || m.kind !== 'count') continue;
                const id = m.stocktakeId || m.id;
                if (!groups.has(id)) groups.set(id, { id, at: m.timestamp, by: m.by || '', device: m.device || '', meta: m.st || null, lines: [] });
                const g = groups.get(id);
                g.lines.unshift(m);
                if (String(m.timestamp) > String(g.at)) g.at = m.timestamp;
            }
            return Array.from(groups.values()).sort((a, b) => String(b.at).localeCompare(String(a.at)));
        }

//@fn printStockTakeReport
// A printable (A4) stock-take report — Phase 11/13: product, previous stock, counted, adjustment, final stock, user, device,
// date/time, stock-take id, and what the server did with each line. Works for every app (Aqua lines carry their site in the name).
function printStockTakeReport(stocktakeId) {
            const g = stockTakeHistoryFromLog().find((x) => String(x.id) === String(stocktakeId));
            if (!g) { showToast('That stock take is not on this device.', true); return; }
            const q = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
            const status = (m) => !m._srv ? 'waiting to sync' : m._srv.applied === false ? 'superseded by a later count' : (m._srv.stale ? 'applied (figure had changed)' : 'applied');
            const rows = g.lines.map((m) => {
                const was = m._srv && typeof m._srv.before === 'number' ? m._srv.before : m.before;
                const now = m._srv && typeof m._srv.after === 'number' ? m._srv.after : m.counted;
                const adj = m._srv ? stockMoveDelta(m) : m.delta;
                const lo = m.unit === 'pieceQty' ? ' loose' : '';
                return `<tr><td>${escapeHtml(m.name || m.code || '')}</td><td class="n">${q(was)}${lo}</td><td class="n">${q(m.counted)}${lo}</td><td class="n">${adj > 0 ? '+' : ''}${q(adj)}${lo}</td><td class="n">${q(now)}${lo}</td><td>${status(m)}</td></tr>`;
            }).join('');
            const h = g.meta || {};
            const biz = (typeof businessName !== 'undefined' && businessName) ? businessName : '';
            printHTMLDirect(`<div class="st-report">
                <h2>${escapeHtml(biz)}${biz ? ' — ' : ''}Stock Take Report</h2>
                <div>${escapeHtml(new Date(g.at).toLocaleString('en-GB'))}${g.by ? ' · counted by ' + escapeHtml(g.by) : ''}${g.device ? ' · device ' + escapeHtml(String(g.device)) : ''}</div>
                <div>Stock take ${escapeHtml(String(g.id))} · ${h.changed || g.lines.length} updated of ${h.counted || g.lines.length} counted${h.missing ? ` · missing KES ${Math.round(h.missing).toLocaleString('en-US')}` : ''}${h.extra ? ` · extra KES ${Math.round(h.extra).toLocaleString('en-US')}` : ''}</div>
                <table><thead><tr><th>Item</th><th class="n">Was</th><th class="n">Counted</th><th class="n">Adjustment</th><th class="n">Now</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
                <p class="foot">"Was" and "Now" are the figures the server confirmed. A count recorded offline keeps its original time and id.</p>
            </div>`, '.st-report{font-family:Arial,sans-serif;padding:16px;color:#000} .st-report h2{margin:0 0 4px} .st-report table{width:100%;border-collapse:collapse;margin-top:10px} .st-report th,.st-report td{border-bottom:1px solid #ccc;padding:5px 6px;font-size:12px;text-align:left} .st-report .n{text-align:right} .st-report .foot{font-size:11px;color:#555;margin-top:10px}');
        }

//@fn stockIntegrityCheck
// "Does everything agree?" (Phase 19) on demand: sends anything unsent, fetches the latest, then asks the server to check its own
// history (/api/stock-integrity) and compares every figure on THIS screen with the server's. Shows the result in `targetId`.
async function stockIntegrityCheck(targetId) {
            const el = document.getElementById(targetId || 'stock-integrity-result');
            const say = (html) => { if (el) el.innerHTML = html; };
            say('<p class="settings-hint" style="margin:0;">Checking…</p>');
            try {
                if (typeof flushThenPull === 'function') await flushThenPull();
                const res = await fetch(apiUrl('/api/stock-integrity'));
                if (!res.ok) { say('<p class="st-bad" style="margin:0;">Could not reach the server — try again when online.</p>'); return null; }
                const out = await res.json();
                const mine = {};
                if (typeof inventory !== 'undefined' && Array.isArray(inventory)) inventory.forEach((r) => {
                    if (!r || r.code == null || r._deleted) return;
                    const list = r.hasVariants && Array.isArray(r.variants) && r.variants.length ? r.variants : [r];
                    list.forEach((x) => { if (x && x.code != null) { mine[String(x.code)] = Number(x.qty) || 0; if (typeof x.pieceQty === 'number') mine[`${x.code}|pieceQty`] = x.pieceQty; } });
                });
                if (typeof aquaCellList === 'function') aquaCellList().forEach((x) => { mine[aquaCellKey(x.cell)] = x.value; });
                const pending = new Set();
                ((typeof stockMovementLog !== 'undefined' && Array.isArray(stockMovementLog)) ? stockMovementLog : []).forEach((m) => { if (m && m.lg && !m._srv) pending.add(m.cell ? aquaCellKey(m.cell) : String(m.code)); });
                const differ = Object.keys(mine).filter((k) => typeof out.figures[k] === 'number' && Math.abs(out.figures[k] - mine[k]) > 1e-6 && !pending.has(k.split('|pieceQty')[0]));
                const lines = [];
                if (out.ok && differ.length === 0) lines.push(`<p class="st-ok" style="margin:0;">✓ All ${Object.keys(mine).length} figures on this device match the server, and the server's history agrees with its figures (${out.checked} items with stock history checked).</p>`);
                if (!out.ok) lines.push(`<p class="st-bad" style="margin:0;">⚠ The server found ${out.problems.length} problem${out.problems.length === 1 ? '' : 's'} in its stock history:</p><ul>${out.problems.slice(0, 20).map((p) => `<li>${escapeHtml(p.what)}: ${escapeHtml(p.detail)}</li>`).join('')}</ul>`);
                if (differ.length) lines.push(`<p class="st-bad" style="margin:0;">⚠ ${differ.length} figure${differ.length === 1 ? '' : 's'} on this device differ from the server (refresh this device):</p><ul>${differ.slice(0, 20).map((k) => `<li>${escapeHtml(k)}: here ${mine[k]}, server ${out.figures[k]}</li>`).join('')}</ul>`);
                if (pending.size) lines.push(`<p class="st-muted" style="margin:4px 0 0;">${pending.size} change${pending.size === 1 ? ' is' : 's are'} still waiting to sync and ${pending.size === 1 ? 'was' : 'were'} not compared.</p>`);
                say(lines.join(''));
                return { ...out, differ };
            } catch (e) {
                say('<p class="st-bad" style="margin:0;">Could not run the check — try again when online.</p>');
                return null;
            }
        }

//@fn stockTakeInstall
function stockTakeInstall() {
            if (window.__stockTakeInstalled) return;
            window.__stockTakeInstalled = true;
            const btn = document.getElementById('stock-take-tab-btn');
            if (btn) btn.addEventListener('click', () => setTimeout(() => { try { renderStockTake(); } catch (e) { /* the tab is an extra */ } }, 60));
        }

//@fn setKitchenPrintPage
function setKitchenPrintPage() {
            // The order ticket printed through the system dialog never set its own paper size, so a receipt printer got a full page's length of
            // paper for a few lines. Same width as the receipt and "auto" length: the slip is only as long as its lines.
            const pageStyle = document.getElementById('print-page-style');
            const w = receiptPaperMm();
            if (pageStyle) pageStyle.textContent = receiptPageRule(w, document.getElementById('kitchen-ticket-paper'));
            document.body.style.setProperty('--receipt-print-width', `${w}mm`);
            document.body.style.setProperty('--receipt-print-zoom', String(((typeof receiptScale !== 'undefined' && Number(receiptScale)) || 100) / 100));
        }

//@fn pruneClosedBills
function pruneClosedBills(days) {
            // Settled bills are now kept (closed) so they show under "Show closed bills"; the ones closed more than `days` days ago are dropped so
            // the list does not grow for ever. (Removal is a normal deletion: the sync sends a tombstone.)
            const limit = Date.now() - (days || 90) * 86400000;
            const keep = bills.filter((b) => {
                if (!b || !b.closed) return true;
                const last = (b.paymentHistory || []).length ? b.paymentHistory[b.paymentHistory.length - 1].timestamp : null;
                const t = Date.parse(b.closedAt || last || b.timestamp || '');
                return !(Number.isFinite(t) && t < limit);
            });
            if (keep.length === bills.length) return 0;
            const n = bills.length - keep.length;
            bills = keep;
            safeSetItem('pos_bills', JSON.stringify(bills));
            queuePush();
            return n;
        }

//@fn authWatchInstall
function authWatchInstall() {
            // Remembers, for this page, that someone has logged in (or signed up): the sign-in / sign-up screen was showing and has been closed.
            // The start-up code used to re-open the "who's logging in?" picker when its first sync finished if it could not tell that — on a slow
            // connection that put the login popup back over an app somebody was already using ("sometimes, when I tap More").
            if (window.__authWatch) return;
            window.__authWatch = true;
            if (!window.MutationObserver) return;
            ['login-screen', 'registration-screen'].forEach((id) => {
                const el = document.getElementById(id);
                if (!el) return;
                const shown = () => !!el.style.display && el.style.display !== 'none';
                let was = shown();
                new MutationObserver(() => { const now = shown(); if (was && !now) window.__adminAuthed = true; was = now; }).observe(el, { attributes: true, attributeFilter: ['style'] });
            });
        }

//@fn dayKeyOf
function dayKeyOf(ts) {
            return bizDayKey(ts);
        }

//@fn bizTzOffsetMin
// zip 127: the shop's BUSINESS time zone, in minutes east of UTC. Kenya / East Africa (EAT, UTC+3, no daylight saving) unless this
// device was told to use its own clock's zone (localStorage pos_business_tz = 'device').
function bizTzOffsetMin() {
            // read at most every 30 s: Daily Sales and the reports ask once per sale
            const c = window.__bizTzCache;
            if (c && Date.now() - c.at < 30000) return c.v;
            let v = null;
            try { v = localStorage.getItem('pos_business_tz'); } catch (e) { /* private mode */ }
            const n = v != null && v !== '' && v !== 'device' ? Number(v) : NaN;
            const out = v === 'device' ? null : (isFinite(n) && Math.abs(n) <= 14 * 60 ? n : 180);
            window.__bizTzCache = { v: out, at: Date.now() };
            return out;
        }

//@fn bizDayKey
// zip 127: the business date (YYYY-MM-DD) of a moment. Daily Sales, reports, X/Z and "today" all use it, so a sale always lands on the
// same day on every device of the shop — even a till whose time zone is set wrong (a PC left on UTC used to file every sale made
// between midnight and 3 a.m. under the day before, and showed another till's early-morning sales on the wrong day).
// On a device already set to East Africa time this is exactly the old calendar date. A Date built on this device as a calendar day
// (local midnight, or 23:59:59 as an end of day — the date pickers and period presets) keeps its own date.
function bizDayKey(t) {
            // Remembered per moment (the dashboard and reports ask for the same sales many times per screen); cleared if the zone changes.
            const off0 = bizTzOffsetMin();
            let memo = window.__bizDayMemo;
            if (!memo || memo.off !== off0 || memo.map.size > 60000) memo = window.__bizDayMemo = { off: off0, map: new Map() };
            const mk = t instanceof Date ? t.getTime() : t;
            if (mk != null && (typeof mk === 'string' || typeof mk === 'number')) {
                const hit = memo.map.get(mk);
                if (hit !== undefined) return hit;
                const v = bizDayKeyCompute(t);
                memo.map.set(mk, v);
                return v;
            }
            return bizDayKeyCompute(t);
        }

//@fn bizDayKeyCompute
function bizDayKeyCompute(t) {
            const d = t instanceof Date ? t : new Date(typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : t);
            if (isNaN(d.getTime())) return '';
            const pad = (n) => String(n).padStart(2, '0');
            const local = () => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            const off = bizTzOffsetMin();
            if (off == null || -d.getTimezoneOffset() === off) return local();
            const h = d.getHours(), mi = d.getMinutes(), se = d.getSeconds(), ms = d.getMilliseconds();
            if ((h === 0 && mi === 0 && se === 0 && ms === 0) || (h === 23 && mi === 59 && se === 59 && (ms === 999 || ms === 0))) return local();
            const b = new Date(d.getTime() + off * 60000);
            return `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}`;
        }

//@fn bizDayBounds
// zip 127: first and last millisecond of a business date (see bizDayKey), as numbers.
function bizDayBounds(key) {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
            if (!m) return null;
            const y = +m[1], mo = +m[2] - 1, da = +m[3];
            const off = bizTzOffsetMin();
            const localStart = new Date(y, mo, da, 0, 0, 0, 0);
            if (off == null || -localStart.getTimezoneOffset() === off) return { from: localStart.getTime(), to: new Date(y, mo, da, 23, 59, 59, 999).getTime() };
            const from = Date.UTC(y, mo, da) - off * 60000;
            return { from, to: from + 86400000 - 1 };
        }

//@fn assignCustomerNo
function assignCustomerNo(sale) {
            // "Customer 12" on the receipt, just above the reference number: how many customers were served today, so printing the last receipt
            // of the day tells you. It starts again at 1 each day. The number is given the first time a receipt is made for a real sale of TODAY
            // and is then kept on the sale (so a reprint, or another till, shows the same number).
            if (!sale) return null;
            if (sale.customerNo) return sale.customerNo;
            if (sale.recordedLate || typeof salesLog === 'undefined') return null;
            const items = Array.isArray(sale.items) ? sale.items : [];
            if (!items.length || items.every((i) => i && (i.unit === 'payment' || i.isPayment))) return null;      // a payment on an old bill is not a new customer
            const today = dayKeyOf(Date.now());
            if (dayKeyOf(sale.timestamp) !== today) return null;
            const inBills = typeof bills !== 'undefined' && Array.isArray(bills) && bills.some((b) => b && b.id === sale.id);
            const stored = salesLog.find((s) => s && s.id === sale.id) || (inBills ? bills.find((b) => b && b.id === sale.id) : null);
            if (!stored) return null;                                                        // only a saved sale takes a number (a preview does not use one up)
            if (stored.customerNo) { sale.customerNo = stored.customerNo; return sale.customerNo; }
            let max = 0;
            // Only sales from the last day and a half can be from today, and ISO times compare as text — so most of a big log is skipped with one
            // cheap comparison instead of a Date for every sale.
            const cutoff = new Date(Date.now() - 36 * 3600000).toISOString();
            const scan = (arr) => { if (Array.isArray(arr)) for (let i = arr.length - 1; i >= 0; i--) { const s = arr[i]; if (s && s.customerNo && String(s.timestamp) >= cutoff && dayKeyOf(s.timestamp) === today) max = Math.max(max, Number(s.customerNo) || 0); } };
            scan(salesLog); if (typeof bills !== 'undefined') scan(bills);
            stored.customerNo = max + 1;
            sale.customerNo = stored.customerNo;
            safeSetItem('pos_sales_log', JSON.stringify(salesLog));
            if (inBills) safeSetItem('pos_bills', JSON.stringify(bills));
            queuePush();
            return sale.customerNo;
        }

//@fn itemSuggestMatches
function itemSuggestMatches(query) {
            const q = String(query || '').trim().toLowerCase();
            const stock = inventory.filter((p) => p && p.type !== 'service' && !p.removed);
            let list;
            if (!q) list = stock.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            else {
                const starts = [], has = [];
                stock.forEach((p) => {
                    const n = String(p.name || '').toLowerCase(), c = String(p.code || '').toLowerCase();
                    if (n.startsWith(q) || c === q) starts.push(p); else if (n.includes(q) || c.includes(q)) has.push(p);
                });
                list = starts.concat(has);
            }
            return list.slice(0, 30);
        }

//@fn itemSuggestBox
function itemSuggestBox() {
            let box = document.getElementById('item-suggest-box');
            if (box) return box;
            const st = document.createElement('style');
            st.textContent = '#item-suggest-box{position:fixed;z-index:100001;background:var(--bg-surface,#fff);color:var(--dark,#2c3e50);border:1px solid var(--border-color,#ccd1d6);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);max-height:260px;overflow-y:auto;display:none;font-size:14px}'
                + '#item-suggest-box .is-opt{padding:9px 12px;border-bottom:1px solid var(--light,#eef0f2);cursor:pointer}#item-suggest-box .is-opt:last-child{border-bottom:none}'
                + '#item-suggest-box .is-opt.on,#item-suggest-box .is-opt:hover{background:var(--tint-info-bg,#EAF4FB)}#item-suggest-box .is-sub{font-size:12px;color:#7f8c8d}'
                + '#item-suggest-box .is-new{padding:9px 12px;font-size:12px;color:#7f8c8d;background:var(--bg-surface-alt,#f7f9fa)}';
            document.head.appendChild(st);
            box = document.createElement('div');
            box.id = 'item-suggest-box';
            document.body.appendChild(box);
            return box;
        }

//@fn itemSuggestShow
function itemSuggestShow(input) {
            // A drop-down under the "item name" box of a restock / order line: it lists what you stock as you type. Pick one to fill in its code, unit
            // and last cost; or just keep typing a name that is not in the list — it is a new item.
            const box = itemSuggestBox();
            const kind = input.dataset.suggest, rowId = Number(input.dataset.row);
            const list = itemSuggestMatches(input.value);
            const typed = input.value.trim();
            const exact = typed && list.some((p) => String(p.name || '').trim().toLowerCase() === typed.toLowerCase());
            box.dataset.kind = kind; box.dataset.row = String(rowId); box._input = input; box._idx = -1;
            box.innerHTML = list.map((p, i) => `<div class="is-opt" data-code="${escapeHtml(p.code)}" data-i="${i}"><strong>${escapeHtml(p.name)}</strong><div class="is-sub">${escapeHtml(p.code || '')} · in stock ${formatQtyDisplay(p.qty || 0, p.unit || 'pcs')}${Number(p.wholesalePrice) > 0 ? ` · last cost KES ${Number(p.wholesalePrice).toLocaleString('en-US')}` : ''}</div></div>`).join('')
                + (typed && !exact ? `<div class="is-new">➕ “${escapeHtml(typed)}” is not in your inventory — keep typing to add it as a new item</div>` : '');
            if (!list.length && !typed) { box.style.display = 'none'; return; }
            const r = input.getBoundingClientRect();
            const w = Math.max(r.width, 260);
            box.style.left = Math.max(4, Math.min(r.left, (window.innerWidth || 800) - w - 4)) + 'px';
            box.style.width = w + 'px';
            const below = (window.innerHeight || 700) - r.bottom;
            if (below < 200 && r.top > below) { box.style.top = 'auto'; box.style.bottom = ((window.innerHeight || 700) - r.top + 2) + 'px'; }
            else { box.style.bottom = 'auto'; box.style.top = (r.bottom + 2) + 'px'; }
            box.style.display = 'block';
        }

//@fn itemSuggestHide
function itemSuggestHide() {
            const box = document.getElementById('item-suggest-box');
            if (box) box.style.display = 'none';
        }

//@fn itemSuggestPick
function itemSuggestPick(kind, rowId, code) {
            const p = inventory.find((x) => x.code === code);
            if (!p) return;
            let focusEl = null;
            if (kind === 'po') {
                const row = poState().draft.find((r) => r.rowId === rowId);
                if (!row) return;
                row.name = p.name; row.code = p.code || ''; row.autoCode = row.code; row.unit = p.unit || 'pcs';
                if (Number(p.wholesalePrice) > 0) row.cost = String(p.wholesalePrice);
                poRenderRows();
                focusEl = document.getElementById(`po-row-${rowId}-qty`);
            } else {
                const row = restockDraft.find((r) => r.rowId === rowId);
                if (!row) return;
                Object.assign(row, { code: p.code || '', name: p.name, unit: p.unit || 'pcs' });
                if (Number(p.wholesalePrice) > 0) row.cost = String(p.wholesalePrice);
                renderRestockRows();
                const tr = document.querySelectorAll('#restock-rows-tbody tr')[restockDraft.indexOf(row)];
                focusEl = tr ? tr.querySelector('input[inputmode="decimal"]') : null;
            }
            itemSuggestHide();
            if (focusEl) { try { focusEl.focus(); if (focusEl.select) focusEl.select(); } catch (e) { /* cosmetic */ } }
            if (typeof renderLowStockStrip === 'function') { try { renderLowStockStrip(kind); } catch (e) { /* extra */ } }
        }

//@fn itemSuggestInstall
function itemSuggestInstall() {
            if (window.__itemSuggestInstalled) return;
            window.__itemSuggestInstalled = true;
            const isField = (el) => el && el.matches && el.matches('input[data-suggest]');
            document.addEventListener('input', (e) => { if (isField(e.target)) itemSuggestShow(e.target); });
            document.addEventListener('focusin', (e) => { if (isField(e.target)) itemSuggestShow(e.target); });
            document.addEventListener('keydown', (e) => {
                const box = document.getElementById('item-suggest-box');
                if (!isField(e.target) || !box || box.style.display === 'none') return;
                const opts = Array.from(box.querySelectorAll('.is-opt'));
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    if (!opts.length) return;
                    box._idx = (box._idx + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
                    opts.forEach((o, i) => o.classList.toggle('on', i === box._idx));
                    opts[box._idx].scrollIntoView({ block: 'nearest' });
                    e.preventDefault();
                } else if (e.key === 'Enter' && box._idx >= 0 && opts[box._idx]) {
                    e.preventDefault();
                    itemSuggestPick(box.dataset.kind, Number(box.dataset.row), opts[box._idx].dataset.code);
                } else if (e.key === 'Escape' || e.key === 'Tab') itemSuggestHide();
            }, true);
            const pick = (e) => {
                const opt = e.target.closest && e.target.closest('#item-suggest-box .is-opt');
                if (!opt) return;
                e.preventDefault();                                            // keep the typing box focused until the pick lands
                const box = document.getElementById('item-suggest-box');
                itemSuggestPick(box.dataset.kind, Number(box.dataset.row), opt.dataset.code);
            };
            document.addEventListener('mousedown', pick, true);
            document.addEventListener('touchstart', pick, { capture: true, passive: false });
            document.addEventListener('click', (e) => { if (!isField(e.target) && !(e.target.closest && e.target.closest('#item-suggest-box'))) itemSuggestHide(); }, true);
            window.addEventListener('scroll', (e) => { if (!(e.target && e.target.closest && e.target.closest('#item-suggest-box'))) itemSuggestHide(); }, true);
            // Width changes only: on phones the keyboard opening and the address bar sliding away both fire 'resize' (zip 122).
            let lastW = window.innerWidth;
            window.addEventListener('resize', () => { if (window.innerWidth !== lastW) { lastW = window.innerWidth; itemSuggestHide(); } });
        }

//@fn showBusyBanner
function showBusyBanner(message) {
            // A visible "please wait" for anything slow (reading a big Excel file, loading the spreadsheet reader...): nothing on screen used to say
            // the app was working, so people tapped again or thought it had frozen.
            let el = document.getElementById('busy-banner');
            if (!el) {
                el = document.createElement('div');
                el.id = 'busy-banner';
                el.setAttribute('role', 'status');
                el.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:200000; background:#2c3e50; color:#fff; padding:12px 16px; font-size:15px; font-weight:600; text-align:center; box-shadow:0 2px 12px rgba(0,0,0,.35); display:none;';
                document.body.appendChild(el);
            }
            el.textContent = message;
            el.style.display = 'block';
        }

//@fn hideBusyBanner
function hideBusyBanner() {
            const el = document.getElementById('busy-banner');
            if (el) el.style.display = 'none';
        }

//@fn nextPaint
function nextPaint() {
            // Lets the browser draw what was just shown (e.g. the busy banner) before heavy work blocks the page.
            return new Promise((resolve) => { const raf = window.requestAnimationFrame || ((f) => setTimeout(f, 16)); raf(() => setTimeout(resolve, 0)); });
        }

//@fn reportMoney
function reportMoney(n) {
            return 'KES ' + Math.round(Number(n) || 0).toLocaleString('en-US');
        }

//@fn reportShort
function reportShort(n) {
            n = Number(n) || 0;
            if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
            return String(Math.round(n));
        }

//@fn reportsRange
function reportsRange() {
            const preset = (document.getElementById('reports-range-select') || {}).value || 'last30';
            // Calendar days are worked out on TODAY's business date (bizDayKey) and turned into business-day bounds (zip 127), so a report
            // covers the same sales as Daily Sales on every device, whatever time zone the device itself is set to.
            const pad = (n) => String(n).padStart(2, '0');
            const kOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            const tk = bizDayKey(Date.now()).split('-').map(Number);
            const now = new Date(tk[0], tk[1] - 1, tk[2], 12, 0, 0, 0);
            const cal = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
            const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);
            let fromDay = cal(now), toDay = cal(now), label = 'Today';
            if (preset === 'yesterday') { fromDay = addDays(now, -1); toDay = addDays(now, -1); label = 'Yesterday'; }
            else if (preset === 'week') { const dow = (now.getDay() + 6) % 7; fromDay = addDays(now, -dow); label = 'This week'; }
            else if (preset === 'last7') { fromDay = addDays(now, -6); label = 'Last 7 days'; }
            else if (preset === 'month') { fromDay = new Date(now.getFullYear(), now.getMonth(), 1, 12); label = 'This month'; }
            else if (preset === 'last30') { fromDay = addDays(now, -29); label = 'Last 30 days'; }
            else if (preset === 'last90') { fromDay = addDays(now, -89); label = 'Last 90 days'; }
            else if (preset === 'year') { fromDay = new Date(now.getFullYear(), 0, 1, 12); label = 'This year'; }
            else if (preset === 'custom') {
                const f = (document.getElementById('reports-from-input') || {}).value, t = (document.getElementById('reports-to-input') || {}).value;
                if (f) fromDay = cal(new Date(f + 'T00:00:00'));
                if (t) toDay = cal(new Date(t + 'T00:00:00'));
                label = 'Custom';
            }
            if (fromDay > toDay) { const x = fromDay; fromDay = toDay; toDay = x; }
            const from = new Date(bizDayBounds(kOf(fromDay)).from), to = new Date(bizDayBounds(kOf(toDay)).to);
            const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
            return { from, to, label, text: kOf(fromDay) === kOf(toDay) ? fmt(fromDay) : `${fmt(fromDay)} – ${fmt(toDay)}` };
        }

//@fn reportSales
function reportSales(range) {
            return salesLog.filter((s) => { if (!s || s.voided) return false; const t = new Date(s.timestamp); return t >= range.from && t <= range.to; });
        }

//@fn reportSaleTotal
function reportSaleTotal(s) {
            return (Array.isArray(s.items) ? s.items : []).reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
        }

//@fn reportSaleCost
function reportSaleCost(s) {
            return (Array.isArray(s.items) ? s.items : []).reduce((sum, it) => {
                if (it.unit === 'payment' || it.isPayment) return sum;
                let cost = Number(it.wholesalePrice);
                if (!(cost > 0) && it.code != null) { const p = inventory.find((x) => x.code === it.code); cost = p ? Number(p.wholesalePrice) || 0 : 0; }
                return sum + (cost || 0) * (Number(it.qty) || 0);
            }, 0);
        }

//@fn reportBarSvg
function reportBarSvg(labels, values, color) {
            const W = 640, H = 220, pl = 44, pr = 8, pt = 10, pb = 26;
            const max = Math.max(1, ...values);
            const bw = (W - pl - pr) / Math.max(1, values.length);
            let g = '';
            for (let i = 0; i <= 4; i++) {
                const y = pt + (H - pt - pb) * (1 - i / 4);
                g += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke="#e5e8eb"/><text x="${pl - 5}" y="${y + 3}" font-size="9" text-anchor="end" fill="#7f8c8d">${reportShort(max * i / 4)}</text>`;
            }
            const step = Math.max(1, Math.ceil(labels.length / 12));
            values.forEach((v, i) => {
                const h = (v / max) * (H - pt - pb);
                g += `<rect x="${(pl + i * bw + bw * 0.15).toFixed(1)}" y="${(H - pb - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" fill="${color || '#E67E22'}" rx="2"><title>${escapeHtml(labels[i])}: ${escapeHtml(reportMoney(v))}</title></rect>`;
                if (i % step === 0) g += `<text x="${(pl + i * bw + bw / 2).toFixed(1)}" y="${H - 9}" font-size="9" text-anchor="middle" fill="#7f8c8d">${escapeHtml(labels[i])}</text>`;
            });
            return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:640px; height:auto;" role="img">${g}</svg>`;
        }

//@fn reportLineSvg
function reportLineSvg(labels, values, color) {
            const W = 640, H = 220, pl = 44, pr = 12, pt = 10, pb = 26;
            const max = Math.max(1, ...values);
            const n = values.length;
            const x = (i) => pl + (n <= 1 ? (W - pl - pr) / 2 : (i / (n - 1)) * (W - pl - pr));
            const y = (v) => pt + (H - pt - pb) * (1 - v / max);
            let g = '';
            for (let i = 0; i <= 4; i++) {
                const yy = pt + (H - pt - pb) * (1 - i / 4);
                g += `<line x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}" stroke="#e5e8eb"/><text x="${pl - 5}" y="${yy + 3}" font-size="9" text-anchor="end" fill="#7f8c8d">${reportShort(max * i / 4)}</text>`;
            }
            const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
            g += `<polyline points="${pts}" fill="none" stroke="${color || '#2980b9'}" stroke-width="2.5" stroke-linejoin="round"/>`;
            const step = Math.max(1, Math.ceil(n / 10));
            values.forEach((v, i) => {
                g += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${color || '#2980b9'}"><title>${escapeHtml(labels[i])}: ${escapeHtml(reportMoney(v))}</title></circle>`;
                if (i % step === 0 || i === n - 1) g += `<text x="${x(i).toFixed(1)}" y="${H - 9}" font-size="9" text-anchor="middle" fill="#7f8c8d">${escapeHtml(labels[i])}</text>`;
            });
            return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:640px; height:auto;" role="img">${g}</svg>`;
        }

//@fn reportTable
function reportTable(head, rows, opts) {
            opts = opts || {};
            const right = new Set(opts.right || []);
            const th = head.map((h, i) => `<th style="text-align:${right.has(i) ? 'right' : 'left'}; padding:6px 8px; border-bottom:2px solid #2c3e50; font-size:12px;">${escapeHtml(h)}</th>`).join('');
            const body = rows.length ? rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${right.has(i) ? 'right' : 'left'}; padding:5px 8px; border-bottom:1px solid #e5e8eb; font-size:13px;">${escapeHtml(String(c))}</td>`).join('')}</tr>`).join('')
                : `<tr><td colspan="${head.length}" style="padding:10px; color:#7f8c8d;">Nothing to show for this period.</td></tr>`;
            return `<div class="table-scroll"><table style="width:100%; border-collapse:collapse;"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
        }

//@fn reportCards
function reportCards(cards) {
            return `<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:10px 0 14px;">${cards.map((c) => `<div style="border:1px solid #e5e8eb; border-radius:10px; padding:10px 12px;"><div style="font-size:12px; color:#7f8c8d;">${escapeHtml(c[0])}</div><div style="font-size:19px; font-weight:700;">${escapeHtml(String(c[1]))}</div>${c[2] ? `<div style="font-size:12px; color:#7f8c8d;">${escapeHtml(String(c[2]))}</div>` : ''}</div>`).join('')}</div>`;
        }

//@fn reportBuildSales
function reportBuildSales(range) {
            const sales = reportSales(range);
            const total = sales.reduce((s, x) => s + reportSaleTotal(x), 0);
            const methods = {};
            sales.forEach((s) => { const m = s.paymentMethod || 'other'; methods[m] = methods[m] || { n: 0, v: 0 }; methods[m].n++; methods[m].v += reportSaleTotal(s); });
            const items = {};
            sales.forEach((s) => (s.items || []).forEach((it) => { if (it.unit === 'payment' || it.isPayment) return; const k = it.name || it.code || '?'; items[k] = items[k] || { q: 0, v: 0 }; items[k].q += Number(it.qty) || 0; items[k].v += (Number(it.price) || 0) * (Number(it.qty) || 0); }));
            const top = Object.entries(items).sort((a, b) => b[1].v - a[1].v);
            const days = new Set(sales.map((s) => dayKeyOf(s.timestamp))).size;
            const cards = [['Total sales', reportMoney(total)], ['Number of sales', sales.length], ['Average sale', reportMoney(sales.length ? total / sales.length : 0)], ['Days with sales', days, days ? 'avg ' + reportMoney(total / days) + ' / day' : '']];
            const mRows = Object.entries(methods).sort((a, b) => b[1].v - a[1].v).map(([m, x]) => [m, x.n, reportMoney(x.v), total ? Math.round(x.v / total * 100) + '%' : '0%']);
            const iRows = top.map(([n, x]) => [n, Math.round(x.q * 100) / 100, reportMoney(x.v), total ? Math.round(x.v / total * 1000) / 10 + '%' : '0%']);
            const html = reportCards(cards) + '<h4>By payment method</h4>' + reportTable(['Method', 'Sales', 'Amount', 'Share'], mRows, { right: [1, 2, 3] })
                + '<h4>Items sold (best first)</h4>' + reportTable(['Item', 'Qty', 'Amount', 'Share'], iRows.slice(0, 60), { right: [1, 2, 3] });
            return { title: 'Sales Report', html, csv: [['Item', 'Qty', 'Amount']].concat(top.map(([n, x]) => [n, x.q, Math.round(x.v)])) };
        }

//@fn reportBuildInsights
function reportBuildInsights(range) {
            const sales = reportSales(range);
            const hours = Array.from({ length: 24 }, () => ({ n: 0, v: 0 }));
            const dows = Array.from({ length: 7 }, () => ({ n: 0, v: 0 }));
            const staffMap = {};
            sales.forEach((s) => {
                const d = new Date(s.timestamp), t = reportSaleTotal(s);
                hours[d.getHours()].n++; hours[d.getHours()].v += t;
                dows[d.getDay()].n++; dows[d.getDay()].v += t;
                const w = s.servedBy || 'Unknown'; staffMap[w] = staffMap[w] || { n: 0, v: 0 }; staffMap[w].n++; staffMap[w].v += t;
            });
            const dowNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const bestHour = hours.reduce((b, h, i) => (h.v > hours[b].v ? i : b), 0);
            const busyHour = hours.reduce((b, h, i) => (h.n > hours[b].n ? i : b), 0);
            const bestDow = dows.reduce((b, h, i) => (h.v > dows[b].v ? i : b), 0);
            const staffSorted = Object.entries(staffMap).sort((a, b) => b[1].v - a[1].v);
            const hh = (h) => `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;
            // trend series: DAILY over the chosen period; WEEKLY over the last 12 weeks; MONTHLY over the last 12 months (independent of the period so a line means something)
            const trendMode = window.__reportsTrend || 'daily';
            const bucket = (mode) => {
                const labels = [], values = [];
                const now = new Date();
                if (mode === 'daily') {
                    const map = {}; sales.forEach((s) => { const k = dayKeyOf(s.timestamp); map[k] = (map[k] || 0) + reportSaleTotal(s); });
                    const k0 = dayKeyOf(range.from).split('-').map(Number), lastKey = dayKeyOf(range.to);
                    for (let d = new Date(k0[0], k0[1] - 1, k0[2]), guard = 0; guard < 4000; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), guard++) { const k = dayKeyOf(d); if (k > lastKey) break; labels.push(d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })); values.push(map[k] || 0); }
                } else if (mode === 'weekly') {
                    const monday = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)); return x; };
                    const start = monday(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7 * 11));
                    const sums = new Array(12).fill(0);
                    salesLog.forEach((s) => { if (!s || s.voided) return; const t = new Date(s.timestamp); if (t < start) return; const i = Math.floor((monday(t) - start) / (7 * 86400000)); if (i >= 0 && i < 12) sums[i] += reportSaleTotal(s); });
                    sums.forEach((v, i) => { const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7 * i); labels.push('Wk ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })); values.push(v); });
                } else {
                    const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
                    const sums = new Array(12).fill(0);
                    salesLog.forEach((s) => { if (!s || s.voided) return; const t = new Date(s.timestamp); const i = (t.getFullYear() - start.getFullYear()) * 12 + t.getMonth() - start.getMonth(); if (i >= 0 && i < 12) sums[i] += reportSaleTotal(s); });
                    sums.forEach((v, i) => { const d = new Date(start.getFullYear(), start.getMonth() + i, 1); labels.push(d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })); values.push(v); });
                }
                return { labels, values };
            };
            const tr = bucket(trendMode);
            const trendBtn = (m, t) => `<button type="button" class="settings-small-btn" style="${trendMode === m ? 'background:#2980b9; color:#fff;' : ''}" onclick="window.__reportsTrend='${m}'; reportsGenerate('insights')">${t}</button>`;
            const summary = sales.length === 0 ? '<p>No sales in this period.</p>'
                : `<ul style="line-height:1.8;"><li><strong>Busiest hour:</strong> ${hh(busyHour)} (${hours[busyHour].n} sales)</li><li><strong>Best-earning hour:</strong> ${hh(bestHour)} (${reportMoney(hours[bestHour].v)})</li><li><strong>Best day of the week:</strong> ${dowNames[bestDow]} (${reportMoney(dows[bestDow].v)})</li>`
                + (staffSorted.length ? `<li><strong>Best worker:</strong> ${escapeHtml(staffSorted[0][0])} (${reportMoney(staffSorted[0][1].v)} from ${staffSorted[0][1].n} sales)</li>` : '') + '</ul>';
            const html = reportCards([['Total sales', reportMoney(sales.reduce((s, x) => s + reportSaleTotal(x), 0))], ['Sales', sales.length]])
                + summary
                + '<h4>Sales by hour of the day</h4>' + reportBarSvg(hours.map((_, i) => String(i)), hours.map((h) => h.v), '#E67E22')
                + '<h4>Sales by day of the week</h4>' + reportBarSvg(dowNames.map((d) => d.slice(0, 3)), dows.map((d) => d.v), '#16a085')
                + `<h4>Sales trend</h4><div style="display:flex; gap:6px; margin-bottom:6px;">${trendBtn('daily', 'Daily (this period)')}${trendBtn('weekly', 'Weekly (12 weeks)')}${trendBtn('monthly', 'Monthly (12 months)')}</div>` + reportLineSvg(tr.labels, tr.values, '#2980b9')
                + '<h4>Workers</h4>' + reportTable(['Worker', 'Sales', 'Amount', 'Average sale'], staffSorted.map(([n, x]) => [n, x.n, reportMoney(x.v), reportMoney(x.n ? x.v / x.n : 0)]), { right: [1, 2, 3] });
            const csv = [['Hour', 'Sales', 'Amount']].concat(hours.map((h, i) => [hh(i), h.n, Math.round(h.v)])).concat([[], ['Day', 'Sales', 'Amount']]).concat(dows.map((d, i) => [dowNames[i], d.n, Math.round(d.v)])).concat([[], ['Trend (' + trendMode + ')', 'Amount']]).concat(tr.labels.map((l, i) => [l, Math.round(tr.values[i])]));
            return { title: 'Business Insights', html, csv };
        }

//@fn reportBuildStaff
function reportBuildStaff(range) {
            const sales = reportSales(range);
            const map = {};
            sales.forEach((s) => { const w = s.servedBy || 'Unknown'; map[w] = map[w] || { n: 0, v: 0, hours: 0 }; map[w].n++; map[w].v += reportSaleTotal(s); });
            const now = Date.now();
            (typeof staffShifts !== 'undefined' ? staffShifts : []).forEach((sh) => {
                if (!sh) return;
                const a = Math.max(sh.clockIn || 0, range.from.getTime()), b = Math.min(sh.clockOut || now, range.to.getTime());
                if (b > a) { const w = sh.name || 'Unknown'; map[w] = map[w] || { n: 0, v: 0, hours: 0 }; map[w].hours += (b - a) / 3600000; }
            });
            const total = Object.values(map).reduce((s, x) => s + x.v, 0);
            const rows = Object.entries(map).sort((a, b) => b[1].v - a[1].v).map(([n, x]) => [n, x.n, reportMoney(x.v), reportMoney(x.n ? x.v / x.n : 0), total ? Math.round(x.v / total * 100) + '%' : '0%', x.hours ? (Math.round(x.hours * 10) / 10) + ' h' : '—', x.hours ? reportMoney(x.v / x.hours) + ' / h' : '—']);
            const html = reportCards([['Total sales', reportMoney(total)], ['Workers', rows.length]]) + reportTable(['Worker', 'Sales', 'Amount', 'Average sale', 'Share', 'Hours worked', 'Sales per hour'], rows, { right: [1, 2, 3, 4, 5, 6] });
            return { title: 'Staff Performance', html, csv: [['Worker', 'Sales', 'Amount', 'Average sale', 'Share', 'Hours', 'Per hour']].concat(rows) };
        }

//@fn reportBuildStock
function reportBuildStock(range) {
            const limit = typeof LOW_STOCK_THRESHOLD !== 'undefined' ? LOW_STOCK_THRESHOLD : 3;
            const rawStock = inventory.filter((p) => p && p.type !== 'service' && !p.removed);
            // Variant-bearing items are replaced by their own variants here
            // — same reasoning as Stock Take (stockTakeItems): the parent's
            // own qty/price are just an aggregate ("5 sizes, 23 units
            // total"), not something to report low-stock/out-of-stock/value
            // on directly; each variant needs its own line. __soldKey
            // matches how a variant sale is actually recorded — cart lines
            // for a variant store the PARENT's code plus a separate
            // variantId (see addToCart), not the variant's own code, so
            // "sold" has to be looked up the same compound way below or
            // every variant of one item would wrongly share one sold count.
            const stock = [];
            rawStock.forEach((p) => {
                if (p.hasVariants && Array.isArray(p.variants) && p.variants.length > 0) {
                    p.variants.forEach((v) => stock.push(Object.assign({}, v, {
                        name: `${p.name} — ${v.name}`,
                        unit: p.unit, category: p.category,
                        __soldKey: `${p.code}::${v.id}`,
                    })));
                } else {
                    stock.push(Object.assign({}, p, { __soldKey: p.code }));
                }
            });
            const sold = {}; reportSales(range).forEach((s) => (s.items || []).forEach((it) => {
                if (it.code == null) return;
                const key = it.variantId ? `${it.code}::${it.variantId}` : it.code;
                sold[key] = (sold[key] || 0) + (Number(it.qty) || 0);
            }));
            const cost = stock.reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.wholesalePrice) || 0), 0);
            const retail = stock.reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.price) || 0), 0);
            const low = stock.filter((p) => (Number(p.qty) || 0) > 0 && (Number(p.qty) || 0) <= limit);
            const out = stock.filter((p) => (Number(p.qty) || 0) <= 0);
            const dead = stock.filter((p) => (Number(p.qty) || 0) > 0 && !sold[p.__soldKey]);
            const row = (p) => [p.name, p.code || '', p.category || '', `${Math.round((Number(p.qty) || 0) * 100) / 100} ${p.unit || ''}`, reportMoney((Number(p.qty) || 0) * (Number(p.wholesalePrice) || 0)), reportMoney((Number(p.qty) || 0) * (Number(p.price) || 0)), sold[p.__soldKey] || 0];
            const head = ['Item', 'Code', 'Category', 'In stock', 'Value (cost)', 'Value (retail)', 'Sold in period'];
            const all = stock.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
            const html = reportCards([['Items stocked', stock.length], ['Stock value (cost)', reportMoney(cost)], ['Stock value (retail)', reportMoney(retail)], ['Low stock', low.length], ['Out of stock', out.length]])
                + '<h4>Low stock (' + low.length + ')</h4>' + reportTable(head, low.map(row), { right: [4, 5, 6] })
                + '<h4>Out of stock (' + out.length + ')</h4>' + reportTable(head, out.slice(0, 200).map(row), { right: [4, 5, 6] })
                + '<h4>Not sold in this period (' + dead.length + ')</h4>' + reportTable(head, dead.slice(0, 200).map(row), { right: [4, 5, 6] })
                + '<h4>Full stock list</h4>' + reportTable(head, all.slice(0, 500).map(row), { right: [4, 5, 6] });
            return { title: 'Stock Report', html, csv: [head].concat(all.map(row)) };
        }

//@fn reportBuildBillsDebts
function reportBuildBillsDebts() {
            const now = Date.now();
            const openBills = (typeof bills !== 'undefined' ? bills : []).filter((b) => b && !b.closed && !b.voided);
            const owed = (b) => Math.max(0, (b.items || []).reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.qty) || 0), 0) - (Number(b.amountPaid) || 0));
            const age = (t) => Math.max(0, Math.floor((now - new Date(t).getTime()) / 86400000));
            const bRows = openBills.map((b) => [b.customerName || 'Customer', new Date(b.timestamp).toLocaleDateString('en-GB'), reportMoney((b.items || []).reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.qty) || 0), 0)), reportMoney(b.amountPaid || 0), reportMoney(owed(b)), age(b.timestamp) + ' d']).sort((a, b) => parseInt(b[5]) - parseInt(a[5]));
            const debtList = (typeof debts !== 'undefined' ? debts : []).filter((d) => d && !d.removed);
            const dOwed = (d) => Math.max(0, (Number(d.amount) || 0) - (Number(d.paidAmount) || 0) - (Array.isArray(d.payments) ? d.payments.reduce((s, p) => s + (Number(p.amount) || 0), 0) : 0));
            const dRows = debtList.filter((d) => dOwed(d) > 0).map((d) => [d.customerName || d.name || 'Customer', new Date(d.createdAt || d.timestamp || now).toLocaleDateString('en-GB'), reportMoney(d.amount), reportMoney(dOwed(d)), age(d.createdAt || d.timestamp || now) + ' d']);
            const billTotal = openBills.reduce((s, b) => s + owed(b), 0), debtTotal = debtList.reduce((s, d) => s + dOwed(d), 0);
            const buckets = [0, 0, 0]; openBills.forEach((b) => { const a = age(b.timestamp); buckets[a <= 7 ? 0 : a <= 30 ? 1 : 2] += owed(b); });
            const html = reportCards([['Open bills', openBills.length, reportMoney(billTotal) + ' owed'], ['Debts owed', dRows.length, reportMoney(debtTotal) + ' owed'], ['Bills 0–7 days', reportMoney(buckets[0])], ['Bills 8–30 days', reportMoney(buckets[1])], ['Bills over 30 days', reportMoney(buckets[2])]])
                + '<h4>Open bills (oldest first)</h4>' + reportTable(['Customer', 'Date', 'Total', 'Paid', 'Owing', 'Age'], bRows, { right: [2, 3, 4, 5] })
                + '<h4>Debts</h4>' + reportTable(['Customer', 'Date', 'Amount', 'Owing', 'Age'], dRows, { right: [2, 3, 4] });
            return { title: 'Bills & Debts', html, csv: [['Customer', 'Date', 'Total', 'Paid', 'Owing', 'Age']].concat(bRows) };
        }

//@fn reportBuildExpenses
function reportBuildExpenses(range) {
            const sales = reportSales(range);
            const revenue = sales.reduce((s, x) => s + reportSaleTotal(x), 0);
            const cogs = sales.reduce((s, x) => s + reportSaleCost(x), 0);
            const exp = (typeof expenses !== 'undefined' ? expenses : []).filter((e) => { if (!e || e.removed) return false; const t = new Date(e.timestamp || e.date); return t >= range.from && t <= range.to; });
            const expTotal = exp.reduce((s, e) => s + (Number(e.amount) || 0), 0);
            const cat = {}; exp.forEach((e) => { const k = e.category || 'Other'; cat[k] = (cat[k] || 0) + (Number(e.amount) || 0); });
            const gross = revenue - cogs, net = gross - expTotal;
            const rows = Object.entries(cat).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, reportMoney(v), expTotal ? Math.round(v / expTotal * 100) + '%' : '0%']);
            const html = reportCards([['Sales', reportMoney(revenue)], ['Cost of goods sold', reportMoney(cogs)], ['Gross profit', reportMoney(gross), revenue ? Math.round(gross / revenue * 100) + '% margin' : ''], ['Expenses', reportMoney(expTotal)], ['Net profit', reportMoney(net)]])
                + '<p style="font-size:12px; color:#7f8c8d;">Cost of goods uses each line\u2019s buying price when recorded, otherwise the item\u2019s current buying price; lines without a buying price count as zero cost.</p>'
                + '<h4>Expenses by category</h4>' + reportTable(['Category', 'Amount', 'Share'], rows, { right: [1, 2] })
                + '<h4>Expense list</h4>' + reportTable(['Date', 'Category', 'Description', 'Amount'], exp.slice().sort((a, b) => new Date(b.timestamp || b.date) - new Date(a.timestamp || a.date)).map((e) => [new Date(e.timestamp || e.date).toLocaleDateString('en-GB'), e.category || '', e.description || '', reportMoney(e.amount)]), { right: [3] });
            return { title: 'Expenses & Profit', html, csv: [['Date', 'Category', 'Description', 'Amount']].concat(exp.map((e) => [new Date(e.timestamp || e.date).toLocaleDateString('en-GB'), e.category || '', e.description || '', Number(e.amount) || 0])) };
        }

//@fn reportsGenerate
function reportsGenerate(kind) {
            const out = document.getElementById('reports-output');
            if (!out) return;
            const range = reportsRange();
            const builders = { sales: reportBuildSales, insights: reportBuildInsights, staff: reportBuildStaff, stock: reportBuildStock, bills: reportBuildBillsDebts, expenses: reportBuildExpenses };
            // X/Z Reports are being rolled out module by module — guarded so
            // a module that doesn't have them yet (reportBuildXReport /
            // reportBuildZReport not declared there) never throws just
            // because this shared function mentions their kind keys.
            if (typeof reportBuildXReport === 'function') builders.xreport = reportBuildXReport;
            if (typeof reportBuildZReport === 'function') builders.zreport = reportBuildZReport;
            const fn = builders[kind];
            if (!fn) return;
            window.__reportKind = kind;
            const fresh = reportFreshnessHtml();          // before building: an X/Z report logs its own event, which is not "unsent data"
            let rep;
            try { rep = fn(range); }
            catch (e) { out.innerHTML = '<p style="color:#c0392b;">This report could not be built: ' + escapeHtml(e.message || String(e)) + '</p>'; return; }
            window.__reportCsv = rep.csv || [];
            window.__reportTitle = rep.title;
            const noRange = kind === 'bills' || kind === 'xreport' || kind === 'zreport';
            out.innerHTML = `<div class="report-head" style="margin-bottom:8px;"><h3 style="margin:0;">${escapeHtml(rep.title)}</h3><div style="color:#7f8c8d; font-size:13px;">${escapeHtml(typeof businessName !== 'undefined' ? businessName : '')}${noRange ? ' — as at today' : ' — ' + escapeHtml(range.text)} · generated ${escapeHtml(new Date().toLocaleString('en-GB'))}</div>${fresh}</div>${rep.html}`;
            reportRefreshAfterSync(() => { if (window.__reportKind === kind) reportsGenerate(kind); });
            if (kind === 'xreport' || kind === 'zreport') { const b = todayBounds(); serverDayCheckInto(out, b.from, b.to, ''); }
            document.querySelectorAll('#reports-tab .report-kind-btn').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
            const act = document.getElementById('reports-actions'); if (act) act.style.display = 'flex';
        }

//@fn reportFreshnessHtml
// Phase 10: say on every report how current its data is. Reports are built from this device's copy of the shop, which is the
// server's data as of the last sync plus anything this device has not sent yet.
function reportFreshnessHtml() {
            let last = 0;
            try { last = parseInt(localStorage.getItem('pos_last_synced_at') || localStorage.getItem('aqua_last_synced_at') || '0', 10) || 0; } catch (e) { /* unknown */ }
            const unsent = typeof hasUnsyncedWork === 'function' && hasUnsyncedWork();
            const when = last ? new Date(last).toLocaleString('en-GB') : 'never';
            return unsent
                ? `<div class="report-fresh" style="margin:6px 0; padding:6px 10px; border-radius:6px; background:#fff3cd; color:#5c4400; font-size:13px;">⚠ This device has changes the server has not received yet — figures from other tills are as of ${escapeHtml(when)}. They update by themselves once it syncs.</div>`
                : `<div class="report-fresh" style="margin:6px 0; font-size:12px; color:#27ae60;">✓ Up to date with the server as of ${escapeHtml(when)} — includes every till that had synced by then.</div>`;
        }

//@fn reportRefreshAfterSync
// Builds the report at once from what the device holds, then syncs in the background and rebuilds it if newer data arrived.
function reportRefreshAfterSync(rebuild) {
            if (window.__reportRefreshing || typeof flushThenPull !== 'function') return;
            window.__reportRefreshing = true;
            let before = '';
            try { before = localStorage.getItem('pos_last_synced_at') || localStorage.getItem('aqua_last_synced_at') || ''; } catch (e) { /* unknown */ }
            Promise.resolve().then(() => flushThenPull()).catch(() => {}).then(() => {
                let after = '';
                try { after = localStorage.getItem('pos_last_synced_at') || localStorage.getItem('aqua_last_synced_at') || ''; } catch (e) { /* unknown */ }
                try { if (after !== before) rebuild(); } catch (e) { /* the shown report stays */ }
            }).finally(() => { window.__reportRefreshing = false; });
        }

//@fn serverDayCheck
// #8: compares this device's sales for a day with the SERVER's, by sale id (see functions/api/day-summary.js). null = no answer.
async function serverDayCheck(from, to, site) {
            try {
                const res = await fetch(apiUrl(`/api/day-summary?from=${+from}&to=${+to}${site ? '&site=' + encodeURIComponent(site) : ''}`));
                if (!res.ok) return null;
                const srv = await res.json();
                const mine = (typeof salesLog !== 'undefined' && Array.isArray(salesLog) ? salesLog : []).filter((x) => {
                    if (!x || x.voided || x._deleted) return false;
                    const t = Date.parse(x.timestamp);
                    return isFinite(t) && t >= +from && t <= +to && (!site || !x.siteId || x.siteId === site);
                }).map((x) => String(x.id));
                const srvSet = new Set(srv.ids || []), mySet = new Set(mine);
                const missingHere = (srv.ids || []).filter((id) => !mySet.has(id));
                const notOnServer = mine.filter((id) => !srvSet.has(id));
                return { srv, missingHere, notOnServer, ok: missingHere.length === 0 && notOnServer.length === 0 };
            } catch (e) { return null; }
        }

//@fn serverDayCheckHtml
function serverDayCheckHtml(r) {
            if (!r) return '<p class="st-muted" style="margin:6px 0 0; font-size:12px;">Server check: not available (offline) — figures are from this device.</p>';
            const money = (v) => (typeof reportMoney === 'function' ? reportMoney(v) : 'KES ' + Math.round(v).toLocaleString('en-US'));
            const head = r.ok
                ? `<p style="margin:6px 0 0; font-size:13px; color:#27ae60;">✓ Server check: the server holds the same ${r.srv.count} sale${r.srv.count === 1 ? '' : 's'} (${money(r.srv.gross)}) for this day.</p>`
                : `<p style="margin:6px 0 0; font-size:13px; color:#c0392b;">⚠ Server check: ${r.missingHere.length ? `${r.missingHere.length} sale${r.missingHere.length === 1 ? ' is' : 's are'} on the server but not on this device yet` : ''}${r.missingHere.length && r.notOnServer.length ? '; ' : ''}${r.notOnServer.length ? `${r.notOnServer.length} sale${r.notOnServer.length === 1 ? '' : 's'} on this device ${r.notOnServer.length === 1 ? 'has' : 'have'} not reached the server` : ''}. Server total: ${r.srv.count} sale${r.srv.count === 1 ? '' : 's'}, ${money(r.srv.gross)}.</p>`;
            const tills = Object.entries(r.srv.byTill || {}).sort((a, b) => (a[0] === '?' ? 1 : b[0] === '?' ? -1 : Number(a[0]) - Number(b[0])));
            const byTill = tills.length > 1 || (tills[0] && tills[0][0] !== '?')
                ? `<div class="table-scroll"><table style="margin-top:6px;"><thead><tr><th>Till</th><th>Sales</th><th>Amount</th></tr></thead><tbody>${tills.map(([t, x]) => `<tr><td>${t === '?' ? 'earlier sales (no till)' : 'Till ' + escapeHtml(t)}</td><td>${x.n}</td><td>${money(x.v)}</td></tr>`).join('')}</tbody></table></div>` : '';
            return head + byTill;
        }

//@fn serverDayCheckInto
async function serverDayCheckInto(el, from, to, site) {
            if (!el) return;
            const holder = document.createElement('div');
            holder.className = 'server-day-check';
            holder.innerHTML = '<p class="st-muted" style="margin:6px 0 0; font-size:12px;">Checking with the server…</p>';
            el.appendChild(holder);
            holder.innerHTML = serverDayCheckHtml(await serverDayCheck(from, to, site));
        }

//@fn todayBounds
function todayBounds() {
            const r = bizDayBounds(bizDayKey(Date.now()));
            return { from: new Date(r.from), to: new Date(r.to) };
        }

//@fn zReportPreflight
// A Z Report is final, so it is only finalized from data the server has confirmed: first send everything and fetch the latest.
// Changes still stuck on this device block it; with no connection at all the manager is told plainly what it will be based on.
async function zReportPreflight() {
            try { if (typeof flushThenPull === 'function') await flushThenPull(); } catch (e) { /* handled below */ }
            if (typeof hasUnsyncedWork === 'function' && hasUnsyncedWork()) {
                showToast('Not finalized: this device has sales or changes the server has not received yet. They are being sent — try again in a moment. (' + netFailReason() + ')', true);
                return false;
            }
            const online = typeof probeServer === 'function' ? (await probeServer(4000)) > 0 : true;
            if (!online) return confirm('You are offline. This Z Report will only include what this device has received from the other tills. Finalize anyway?');
            // #8: online, the device's day must match the server's, sale by sale
            const b = todayBounds();
            const site = (typeof activeSiteId !== 'undefined' && activeSiteId && activeSiteId !== 'both') ? activeSiteId : '';
            const chk = await serverDayCheck(b.from, b.to, site);
            if (chk && !chk.ok) {
                showToast(`Not finalized: ${chk.missingHere.length ? chk.missingHere.length + ' sale(s) from other tills have not reached this device yet — wait a moment and try again' : chk.notOnServer.length + ' sale(s) on this device have not reached the server'}.`, true);
                return false;
            }
            return true;
        }

//@fn reportsRangeChanged
function reportsRangeChanged() {
            const custom = (document.getElementById('reports-range-select') || {}).value === 'custom';
            const c = document.getElementById('reports-custom-range'); if (c) c.style.display = custom ? 'flex' : 'none';
            if (window.__reportKind) reportsGenerate(window.__reportKind);
        }

//@fn reportsCsv
function reportsCsv() {
            const rows = window.__reportCsv || [];
            if (!rows.length) { showToast('Generate a report first.', true); return; }
            const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
            const blob = new Blob(['\ufeff' + rows.map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${String(window.__reportTitle || 'report').replace(/\W+/g, '-').toLowerCase()}-${dayKeyOf(Date.now())}.csv`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        }

//@fn reportsPrint
function reportsPrint() {
            if (!window.__reportKind) { showToast('Generate a report first.', true); return false; }
            // A4 for a report (the page size a receipt set earlier would make it 80 mm wide), restored afterwards.
            const pageStyle = document.getElementById('print-page-style');
            const previous = pageStyle ? pageStyle.textContent : '';
            if (pageStyle) pageStyle.textContent = '@page { size: A4; margin: 12mm; }';
            let restored = false;
            const restore = () => { if (restored) return; restored = true; if (pageStyle) pageStyle.textContent = previous; window.removeEventListener('afterprint', restore); };
            window.addEventListener('afterprint', restore);
            setTimeout(restore, 10000);
            const css = 'table{width:100%; border-collapse:collapse;} svg{max-width:100%; height:auto;} h3,h4{margin:8px 0 4px;} .table-scroll{overflow:visible;}';
            const html = document.getElementById('reports-output').innerHTML;
            if (typeof printHTMLDirect === 'function' && document.getElementById('aqua-pos-print-area')) { printHTMLDirect(html, css); return true; }
            // (apps without the in-page print area: print from a fresh window)
            const win = window.open('', '_blank');
            if (!win) { showToast('Allow pop-ups to print the report.', true); restore(); return false; }
            win.document.write(`<html><head><title>${escapeHtml(window.__reportTitle || 'Report')}</title><style>body{font-family:Arial,sans-serif; padding:16px;} ${css}</style></head><body>${html}</body></html>`);
            win.document.close(); win.focus();
            setTimeout(() => win.print(), 300);
            return true;
        }

//@fn reportsInstall
function reportsInstall() {
            if (window.__reportsInstalled) return;
            window.__reportsInstalled = true;
            const btn = document.getElementById('reports-tab-btn');
            if (btn) btn.addEventListener('click', () => setTimeout(() => { try { reportsGenerate(window.__reportKind || 'sales'); } catch (e) { /* the tab is an extra */ } try { if (typeof renderAutoDailyReportStatus === 'function') renderAutoDailyReportStatus(); } catch (e) { /* older module without this yet */ } }, 60));
            // shortcuts to the app's own detailed screens: only the ones this app has
            document.querySelectorAll('#reports-more-links [data-goto]').forEach((b2) => { if (!document.querySelector('.tabs .tab-link[data-tab="' + b2.dataset.goto + '"]')) b2.style.display = 'none'; });
        }

//@fn reportsGoto
function reportsGoto(tabId) {
            const b = document.querySelector('.tabs .tab-link[data-tab="' + tabId + '"]');
            if (b) b.click();
        }

//@fn dedupeStaff
function dedupeStaff() {
            // The same person listed twice on "Who's logging in?": a double tap on "Create my account" (or the same invite opened on two phones) made two staff
            // records, one per tap. Records that are identical in the ways that matter — same name AND same PIN — are one person: every device keeps the
            // record with the smallest id (so they all pick the same one), the other is retired (`removed`, like any removed staff member, so it syncs) and its
            // shifts move to the one kept. Two different people who happen to share a name have different PINs and are left alone.
            let changed = false;
            const groups = new Map();
            staff.forEach((s) => {
                if (!s || s.removed || !s.pinHash) return;
                const key = String(s.name || '').trim().toLowerCase() + '|' + s.pinHash;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(s);
            });
            groups.forEach((list) => {
                if (list.length < 2) return;
                list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
                const keep = list[0];
                list.slice(1).forEach((dup) => {
                    if (typeof staffShifts !== 'undefined') staffShifts.forEach((sh) => { if (sh && sh.staffId === dup.id) sh.staffId = keep.id; });
                    if (Array.isArray(dup.roles) && Array.isArray(keep.roles)) dup.roles.forEach((r) => { if (!keep.roles.includes(r)) keep.roles.push(r); });
                    dup.removed = true;
                    dup.updatedAt = Date.now();
                    changed = true;
                });
            });
            if (changed) {
                safeSetItem(hwKey('staff'), JSON.stringify(staff));
                if (typeof staffShifts !== 'undefined') safeSetItem(hwKey('staff_shifts'), JSON.stringify(staffShifts));
                queuePush();
            }
            return changed;
        }


//@fn vatRateForCategory
        function vatRateForCategory(cat) {
            if (cat === 'B') return VAT_RATE_B;
            // Z (zero-rated), E (exempt) and N (non-VAT) are all 0% but stay
            // distinct classifications for KRA/eTIMS reporting — never merge
            // them back into one bucket. 'C' is the pre-migration legacy
            // code (auto-migrated to 'Z' on load; kept here only as a
            // defensive fallback in case a synced-in record still has it).
            if (cat === 'Z' || cat === 'E' || cat === 'N' || cat === 'C') return 0;
            return VAT_RATE_A; // default / legacy items with no category = standard rate
        }

        // KRA/eTIMS classification labels shown in the UI and on reports.

//@fn KRA_VAT_CATEGORY_LABELS
        const KRA_VAT_CATEGORY_LABELS = {
            A: 'Standard rate (16%)',
            B: 'Reduced rate (8%)',
            Z: 'Zero-rated (0%)',
            E: 'Exempt (0%, no input credit)',
            N: 'Non-VAT'
        };

        // Records a KRA/eTIMS classification change on the item itself, so
        // there is always a trail of who/when/why without needing a
        // separate audit store. `source` is 'manual' (a person changed it
        // in Inventory), 'migration' (this app version changed the data
        // shape) or 'assistant' (the classification helper, once built).
        // Kept lightweight/append-only; capped so it can't grow unbounded.

//@fn recordKraClassificationChange
        function recordKraClassificationChange(item, previousValue, newValue, source, reason) {
            if (!item.kraClassificationHistory) item.kraClassificationHistory = [];
            item.kraClassificationHistory.push({
                date: new Date().toISOString(),
                user: (source === 'migration') ? 'system' : ((typeof activeServerName === 'function' && activeServerName()) || 'admin'),
                source,
                previousValue: previousValue || null,
                newValue: newValue || null,
                reason: reason || ''
            });
            if (item.kraClassificationHistory.length > 50) {
                item.kraClassificationHistory = item.kraClassificationHistory.slice(-50);
            }
        }

        // Per-item KRA/eTIMS classification block (separate from the A/B/Z/E/N
        // VAT rate category above — this is the item-level identity KRA/eTIMS
        // needs: class code, item code, unit/package codes, origin, item
        // type). Never invented — every field defaults to "Not yet
        // classified" until a person or an authoritative source sets it.

//@fn defaultKraClassification
        function defaultKraClassification() {
            return {
                status: 'Not yet classified', // 'Not yet classified' | 'Confirmed' | 'Suggested'
                kraClassCode: '',
                etimsItemCode: '',
                unitCode: '',
                packageCode: '',
                countryOfOrigin: '',
                itemType: ''
            };
        }

        // Reads the Add/Edit Item form's KRA/eTIMS fields, carries forward
        // `existingKra` for anything left blank, and logs a classification
        // change (per section 15 of the audit spec) if any field actually
        // changed. Status becomes 'Confirmed' once every code field is
        // filled in by a person; stays 'Not yet classified' until then —
        // never auto-upgraded to Confirmed by a guess.
        // ---------- KRA CLASSIFICATION ASSISTANT ----------
        // Spec section 14. Never invents an official KRA class code or
        // eTIMS item code — this app has no live KRA API to draw from, so
        // it only ever suggests the VAT/tax CATEGORY (Standard / Reduced /
        // Zero-rated / Exempt / Non-VAT) from a small, editable reference
        // table, always labelled as a suggestion the business's own
        // accountant should confirm — never "CONFIRMED MATCH", since
        // nothing here is an authoritative source. Codes stay
        // "Not yet classified" until a person enters a real one.
        //
        // Starter reference rules only — genuinely common, widely-known
        // treatment categories, not a verified live KRA feed. An
        // authorized admin can add/edit rules below; this is the
        // "updateable KRA classification data layer" the spec asks for
        // when no live API is available.

//@fn KRA_REFERENCE_RULES_BUILTIN
        const KRA_REFERENCE_RULES_BUILTIN = [
            { id: 'builtin-unprocessed-food', keywords: ['maize', 'flour', 'unga', 'bread', 'milk', 'vegetable', 'vegetables', 'fruit', 'fruits', 'potato', 'potatoes', 'onion', 'onions', 'tomato', 'tomatoes', 'rice', 'beans', 'sugar cane', 'raw', 'unprocessed'], category: 'Z', reason: 'Many basic/unprocessed foodstuffs are zero-rated under the VAT Act — verify this specific item and its processing state with your accountant.' },
            { id: 'builtin-pharma', keywords: ['medicine', 'drug', 'drugs', 'pharmaceutical', 'tablet', 'tablets', 'capsule', 'capsules', 'syrup', 'antibiotic', 'painkiller', 'vaccine'], category: 'Z', reason: 'Pharmaceuticals are commonly zero-rated — verify the specific product against the current VAT Act schedule.' },
            { id: 'builtin-lpg', keywords: ['lpg', 'cooking gas', 'gas cylinder', 'gas refill'], category: 'Z', reason: 'LPG/cooking gas has commonly been zero-rated — verify the current rate, as this has changed before.' },
            { id: 'builtin-medical-equipment', keywords: ['wheelchair', 'hearing aid', 'prosthetic', 'medical equipment', 'x-ray', 'dialysis'], category: 'Z', reason: 'Specialized medical equipment is commonly zero-rated or exempt — verify the specific item.' },
            { id: 'builtin-financial', keywords: ['insurance', 'loan interest', 'bank charges', 'financial service'], category: 'E', reason: 'Financial and insurance services are commonly VAT-exempt — verify with your accountant.' },
            { id: 'builtin-education', keywords: ['textbook', 'exercise book', 'school book', 'educational material'], category: 'Z', reason: 'Educational materials are commonly zero-rated — verify the specific item.' },
            { id: 'builtin-export', keywords: ['export', 'exported'], category: 'Z', reason: 'Exported goods are commonly zero-rated.' },
            { id: 'builtin-fuel', keywords: ['petrol', 'diesel', 'fuel', 'kerosene'], category: 'B', reason: 'Petroleum products commonly carry a reduced/special VAT rate — verify the current rate, as this changes periodically.' },
        ];

//@fn kraReferenceRules
        function kraReferenceRules() {
            const custom = safeJSONParse('pos_kra_reference_rules', []);
            return KRA_REFERENCE_RULES_BUILTIN.concat(Array.isArray(custom) ? custom : []);
        }

//@fn addKraReferenceRule
        function addKraReferenceRule(keywordsCsv, category, reason) {
            const custom = safeJSONParse('pos_kra_reference_rules', []);
            const keywords = keywordsCsv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            if (!keywords.length || !category) return false;
            custom.push({ id: `custom-${generateToken()}`, keywords, category, reason: reason || 'Added by an admin for this business.', addedBy: activeServerName(), addedAt: new Date().toISOString() });
            safeSetItem('pos_kra_reference_rules', JSON.stringify(custom));
            return true;
        }

        // Scores every rule by how many of its keywords appear in the
        // product's own text (name + category + optional brand/description
        // typed into the assistant prompt) — a simple, transparent match,
        // never a black box.

//@fn matchKraReferenceRules
        function matchKraReferenceRules(text) {
            const hay = (text || '').toLowerCase();
            const scored = kraReferenceRules().map(rule => {
                const hits = rule.keywords.filter(k => hay.includes(k));
                return { rule, score: hits.length, hits };
            }).filter(m => m.score > 0);
            scored.sort((a, b) => b.score - a.score);
            return scored;
        }

//@fn runKraClassificationAssistant
        function runKraClassificationAssistant() {
            const name = (document.getElementById('inv-name') || {}).value || '';
            const text = name;
            const matches = matchKraReferenceRules(text);
            const box = document.getElementById('inv-kra-assist-result');
            if (!box) return;
            if (matches.length === 0) {
                box.innerHTML = `<div style="border:1px solid #e67e22; background:#fff8ec; border-radius:8px; padding:8px 10px; margin-bottom:8px; font-size:13px;">
                    <strong>NO MATCH FOUND</strong> — manual classification required. Nothing in the reference table matched "${escapeHtml(name)}". Ask your accountant, or add a rule for this kind of item below.
                    <div style="margin-top:6px; display:flex; gap:4px; flex-wrap:wrap;">
                        <input type="text" id="inv-kra-new-rule-keywords" placeholder="keywords, comma-separated" style="flex:1; min-width:120px;">
                        <select id="inv-kra-new-rule-category" style="max-width:220px;">
                            <option value="A">A — Standard rate (16%)</option>
                            <option value="B">B — Reduced rate (8%)</option>
                            <option value="Z">Z — Zero-rated (0%)</option>
                            <option value="E">E — Exempt (0%, no input credit)</option>
                            <option value="N">N — Non-VAT</option>
                        </select>
                        <button type="button" class="settings-small-btn" onclick="submitNewKraReferenceRule()">Save rule</button>
                    </div>
                </div>`;
                return;
            }
            const top = matches[0];
            const tiedTop = matches.filter(m => m.score === top.score);
            const optionHtml = (m, idx) => `<div style="border:1px solid #ccd1d6; border-radius:8px; padding:8px 10px; margin-bottom:6px; font-size:13px;">
                <strong>${escapeHtml(KRA_VAT_CATEGORY_LABELS[m.rule.category] || m.rule.category)}</strong> (category ${escapeHtml(m.rule.category)})
                <div style="color:#7f8c8d; margin:2px 0;">Matched on: ${m.hits.map(escapeHtml).join(', ')}</div>
                <div style="margin-bottom:6px;">${escapeHtml(m.rule.reason || '')}</div>
                <button type="button" class="settings-small-btn" onclick="acceptKraAssistantSuggestion('${m.rule.category}', ${idx})">Use this classification</button>
            </div>`;
            const heading = tiedTop.length > 1
                ? `<strong>${tiedTop.length} possible matches</strong> — multiple classifications fit; pick the right one (or neither) rather than guessing:`
                : `<strong>SUGGESTED MATCH</strong> — review before accepting, this is not an authoritative source:`;
            box.innerHTML = `<div style="border:1px solid #2980b9; background:#eef6fb; border-radius:8px; padding:8px 10px; margin-bottom:8px; font-size:13px;">${heading}</div>`
                + matches.slice(0, 5).map(optionHtml).join('');
        }

//@fn submitNewKraReferenceRule
        function submitNewKraReferenceRule() {
            const kw = (document.getElementById('inv-kra-new-rule-keywords') || {}).value || '';
            const cat = (document.getElementById('inv-kra-new-rule-category') || {}).value || '';
            if (!kw.trim()) { showToast('Enter at least one keyword.', true); return; }
            addKraReferenceRule(kw, cat, `Added by ${activeServerName()} while classifying an item.`);
            showToast('Reference rule saved — it will be suggested for similar items from now on.');
            runKraClassificationAssistant();
        }

        // Accepting a suggestion only ever sets the VAT rate category —
        // never a class/eTIMS code, since those still have to be entered
        // by a person from a real source. Logged as source 'assistant' so
        // the classification-history trail shows it was suggested, not
        // pulled from an authoritative feed.

//@fn acceptKraAssistantSuggestion
        function acceptKraAssistantSuggestion(category) {
            const select = document.getElementById('inv-vat-category');
            if (select) select.value = category;
            const box = document.getElementById('inv-kra-assist-result');
            if (box) box.innerHTML = `<div style="border:1px solid #27ae60; background:#eafaf1; border-radius:8px; padding:8px 10px; margin-bottom:8px; font-size:13px;">VAT category set to ${escapeHtml(category)} from the assistant's suggestion — save the item to keep it. This is not yet a confirmed KRA class/eTIMS code; add those separately once you have them.</div>`;
        }

//@fn readKraClassificationFromForm
        function readKraClassificationFromForm(item, existingKra) {


            const prior = existingKra || defaultKraClassification();
            const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
            const next = {
                kraClassCode: val('inv-kra-class-code'),
                etimsItemCode: val('inv-kra-etims-code'),
                unitCode: val('inv-kra-unit-code'),
                packageCode: val('inv-kra-package-code'),
                countryOfOrigin: val('inv-kra-origin'),
                itemType: val('inv-kra-item-type')
            };
            next.status = (next.kraClassCode && next.etimsItemCode) ? 'Confirmed' : 'Not yet classified';
            const changedFields = Object.keys(next).filter(k => (prior[k] || '') !== (next[k] || ''));
            if (changedFields.length > 0 && item) {
                recordKraClassificationChange(
                    item,
                    JSON.stringify({ status: prior.status, kraClassCode: prior.kraClassCode, etimsItemCode: prior.etimsItemCode }),
                    JSON.stringify({ status: next.status, kraClassCode: next.kraClassCode, etimsItemCode: next.etimsItemCode }),
                    'manual',
                    `Fields changed: ${changedFields.join(', ')}`
                );
            }
            return next;
        }

        // Populates the KRA/eTIMS form fields when opening an item/service to
        // edit — mirrors readKraClassificationFromForm in reverse.

//@fn populateKraClassificationForm
        function populateKraClassificationForm(kra) {
            const k = kra || defaultKraClassification();
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
            set('inv-kra-class-code', k.kraClassCode);
            set('inv-kra-etims-code', k.etimsItemCode);
            set('inv-kra-unit-code', k.unitCode);
            set('inv-kra-package-code', k.packageCode);
            set('inv-kra-origin', k.countryOfOrigin);
            set('inv-kra-item-type', k.itemType);
            const hint = document.getElementById('inv-kra-status-hint');
            if (hint) hint.textContent = k.status || 'Not yet classified';
        }

//@fn validateSaleForEtims
        function validateSaleForEtims(sale) {
            const errors = [];
            const warnings = [];
            (sale.items || []).forEach(it => {
                if (!it || it.unit === 'payment' || it.isPayment) return;
                const label = it.name || it.code || 'an item';
                if (!it.name) {
                    errors.push({ item: label, issue: 'Missing item name', why: 'KRA requires a described item name on every invoice line.', fix: 'Edit the item in Inventory to give it a proper name, then retry.' });
                }
                if (!(Number(it.qty) > 0)) {
                    errors.push({ item: label, issue: `Invalid quantity (${it.qty})`, why: 'eTIMS rejects lines with zero or negative quantity.', fix: 'Check how this sale line was recorded.' });
                }
                if (!(Number(it.price) >= 0)) {
                    errors.push({ item: label, issue: `Invalid price (${it.price})`, why: 'eTIMS requires a valid, non-negative unit price.', fix: 'Check the price on this sale line.' });
                }
                const cat = it.vatCategory || 'A';
                if (!['A', 'B', 'Z', 'E', 'N'].includes(cat)) {
                    errors.push({ item: label, issue: `Unknown VAT category "${cat}"`, why: 'KRA requires a recognized tax type for every line.', fix: 'Set a valid VAT category on this item in Inventory.' });
                }
                if (it.code) {
                    const product = inventory.find(p => p.code === it.code);
                    if (product && (!product.kra || product.kra.status === 'Not yet classified')) {
                        warnings.push({ item: product.name, issue: 'KRA/eTIMS classification not yet set', why: 'Submitting without a confirmed KRA class code and eTIMS item code risks this item being misreported once KRA cross-checks it.', fix: 'Open the item in Inventory and use "Help me classify this product", or enter its KRA class/eTIMS codes directly.' });
                    }
                }
            });
            return { errors, warnings };
        }


//@fn autoDailyReportState
let autoDailyReportEnabled = localStorage.getItem('pos_auto_daily_report_enabled') === 'true';
        let autoDailyReportTime = localStorage.getItem('pos_auto_daily_report_time') || '20:00';
        let autoDailyReportMissedBehavior = localStorage.getItem('pos_auto_daily_report_missed_behavior') || 'generate-on-return';
        let autoDailyReportLog = safeJSONParse('pos_auto_daily_report_log', []);

//@fn setAutoDailyReportEnabled
function setAutoDailyReportEnabled(checked) {
            autoDailyReportEnabled = !!checked;
            localStorage.setItem('pos_auto_daily_report_enabled', String(autoDailyReportEnabled));
            const opts = document.getElementById('auto-daily-report-options');
            if (opts) opts.style.opacity = autoDailyReportEnabled ? '1' : '0.5';
            renderAutoDailyReportStatus();
            queuePush();
        }

//@fn setAutoDailyReportTime
function setAutoDailyReportTime(value) {
            if (!/^\d{2}:\d{2}$/.test(value || '')) return;
            autoDailyReportTime = value;
            localStorage.setItem('pos_auto_daily_report_time', autoDailyReportTime);
            renderAutoDailyReportStatus();
            queuePush();
        }

//@fn setAutoDailyReportMissedBehavior
function setAutoDailyReportMissedBehavior(value) {
            autoDailyReportMissedBehavior = (value === 'scheduled-only') ? 'scheduled-only' : 'generate-on-return';
            localStorage.setItem('pos_auto_daily_report_missed_behavior', autoDailyReportMissedBehavior);
            queuePush();
        }

//@fn renderAutoDailyReportStatus
// Reflects saved settings into the Reports-tab controls, and shows
// whether today's business date has already had its automatic report
// run — kept separate from the scheduler logic so opening the tab never
// itself triggers a run.
function renderAutoDailyReportStatus() {
            const toggle = document.getElementById('auto-daily-report-enabled-toggle');
            const timeInput = document.getElementById('auto-daily-report-time-input');
            const missedSelect = document.getElementById('auto-daily-report-missed-select');
            const opts = document.getElementById('auto-daily-report-options');
            const status = document.getElementById('auto-daily-report-status');
            if (toggle) toggle.checked = autoDailyReportEnabled;
            if (timeInput) timeInput.value = autoDailyReportTime;
            if (missedSelect) missedSelect.value = autoDailyReportMissedBehavior;
            if (opts) opts.style.opacity = autoDailyReportEnabled ? '1' : '0.5';
            if (!status) return;
            if (!autoDailyReportEnabled) { status.textContent = 'Off — the Daily Sales Report is only printed manually.'; return; }
            const today = todayLocalDateStr();
            const todays = autoDailyReportLog.find(e => e.businessDate === today);
            if (!todays) { status.textContent = `Scheduled for ${autoDailyReportTime} today — not yet run.`; return; }
            const when = new Date(todays.executedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            const label = todays.printStatus === 'printed' ? `printed at ${when}` : todays.printStatus === 'print-blocked' ? `generated at ${when}, but nothing was printed (${escapeHtml(todays.error || 'no printer path available')})` : todays.printStatus === 'print-failed' ? `generated at ${when}, but printing failed (${escapeHtml(todays.error || 'unknown error')})` : `generated at ${when}`;
            status.textContent = `Today's report already ${label}.`;
        }

//@fn runAutoDailyReport
// Separates GENERATION (always recorded, always attempted) from PRINT
// OUTPUT (best-effort — a browser/PWA can't silently print without a
// selected printer, so a failure here still leaves the report generated
// and logged, never silently lost). Idempotency is enforced by the
// caller (checkAutoDailyReportSchedule) checking autoDailyReportLog for
// today's business date before ever calling this.
function runAutoDailyReport() {
            const today = todayLocalDateStr();
            const entry = {
                id: generateToken(), businessDate: today,
                scheduledTime: autoDailyReportTime,
                executedAt: Date.now(),
                deviceId: (typeof getOrCreateDeviceId === 'function') ? getOrCreateDeviceId() : null,
                printStatus: 'generated',
                error: null,
            };
            try {
                const range = (typeof todaysReportRange === 'function') ? todaysReportRange() : { from: new Date(new Date().setHours(0, 0, 0, 0)), to: new Date(new Date().setHours(23, 59, 59, 999)) };
                const rep = reportBuildSales(range);
                const out = document.getElementById('reports-output');
                if (out) {
                    out.innerHTML = `<div class="report-head" style="margin-bottom:8px;"><h3 style="margin:0;">${escapeHtml(rep.title)}</h3><div style="color:#7f8c8d; font-size:13px;">Automatic Daily Report — ${escapeHtml(today)}</div></div>${rep.html}`;
                    window.__reportKind = 'sales';
                    window.__reportCsv = rep.csv || [];
                    window.__reportTitle = rep.title;
                    const act = document.getElementById('reports-actions'); if (act) act.style.display = 'flex';
                }
                try {
                    const printed = reportsPrint();
                    entry.printStatus = printed ? 'printed' : 'print-blocked';
                    if (!printed) entry.error = 'No pop-up/print path was available (blocked, or no printer flow set up).';
                } catch (e) {
                    entry.printStatus = 'print-failed';
                    entry.error = String((e && e.message) || e);
                }
            } catch (e) {
                entry.printStatus = 'generation-failed';
                entry.error = String((e && e.message) || e);
            }
            autoDailyReportLog.push(entry);
            if (autoDailyReportLog.length > 90) autoDailyReportLog = autoDailyReportLog.slice(-90);
            safeSetItem('pos_auto_daily_report_log', JSON.stringify(autoDailyReportLog));
            queuePush();
            if (typeof logPosControlReportEvent === 'function') {
                logPosControlReportEvent('daily', entry.printStatus === 'printed' ? 'auto-printed' : 'auto-generated', { reportId: entry.id, totalsSnapshot: { printStatus: entry.printStatus, error: entry.error } });
            }
            renderAutoDailyReportStatus();
        }

//@fn checkAutoDailyReportSchedule
// Runs on a timer (installed alongside the other periodic checks) and
// on load/visibility-change, so a device that was off, asleep or the tab
// closed at the scheduled time still gets a chance to catch up. Never
// fires twice for the same business date — that check happens here,
// before runAutoDailyReport is ever called, not inside it, so a test or
// a future caller can't accidentally bypass it.
function checkAutoDailyReportSchedule() {
            if (!autoDailyReportEnabled) return;
            const today = todayLocalDateStr();
            if (autoDailyReportLog.some(e => e.businessDate === today)) return;
            const now = new Date();
            const parts = (autoDailyReportTime || '20:00').split(':');
            const hh = parseInt(parts[0], 10) || 0;
            const mm = parseInt(parts[1], 10) || 0;
            const scheduled = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
            if (autoDailyReportMissedBehavior === 'scheduled-only') {
                // This check runs roughly once a minute — a 3-minute window
                // comfortably catches the scheduled minute without needing
                // second-level precision, but a device that was off during
                // that window still counts as missed (by design).
                const diff = now.getTime() - scheduled.getTime();
                if (diff >= 0 && diff < 3 * 60000) runAutoDailyReport();
            } else if (now.getTime() >= scheduled.getTime()) {
                runAutoDailyReport();
            }
        }

//@fn installAutoDailyReportScheduler
// Installed once from each app's own startPolling()-equivalent, right
// alongside the eTIMS retry timer — same reasoning: a background check
// that needs to keep running for as long as the app is open, and also
// needs a chance to catch up right after load (the "missed report"
// case: device was off/asleep/closed at the scheduled time).
function installAutoDailyReportScheduler() {
            if (window.__autoDailyReportSchedulerInstalled) return;
            window.__autoDailyReportSchedulerInstalled = true;
            checkAutoDailyReportSchedule();
            setInterval(checkAutoDailyReportSchedule, 60000);
            document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAutoDailyReportSchedule(); });
        }

//@fn goToFirstAllowedTab
function goToFirstAllowedTab() {
            // Lands on the first tab this person may use (tab-bar order). A staff member is never parked on a tab they were not given —
            // including the Sales Counter, which is a role like any other. With no tab at all, an explanation shows instead of a
            // tab's contents. (zip 143)
            let notice = document.getElementById('no-tabs-assigned-notice');
            const firstContent = document.querySelector('.tab-content');
            if (!notice && firstContent && firstContent.parentNode) {
                notice = document.createElement('div');
                notice.id = 'no-tabs-assigned-notice';
                notice.style.cssText = 'display:none; margin:24px auto; max-width:480px; padding:20px; border-radius:10px; background:#fff8e1; color:#5d4037; text-align:center; font-size:15px; line-height:1.5;';
                notice.innerHTML = '<div style="font-size:32px;">🔒</div><strong>No tabs have been given to your account yet.</strong><br>Ask the admin to tick the tabs you should use in 👥 Staff.';
                firstContent.parentNode.insertBefore(notice, firstContent);
            }
            const allowed = Array.from(document.querySelectorAll('.tab-link[data-tab]')).find((b) => b.style.display !== 'none'
                && document.getElementById(b.dataset.tab)
                && !(typeof isTabLocked === 'function' && isTabLocked(b.dataset.tab)));
            if (allowed) {
                if (notice) notice.style.display = 'none';
                performTabSwitch(allowed, allowed.dataset.tab);
                return true;
            }
            document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
            document.querySelectorAll('.tab-link').forEach((el) => el.classList.remove('active'));
            if (notice) notice.style.display = 'block';
            return false;
        }

//@fn openSalesCounterIfAllowed
function openSalesCounterIfAllowed() {
            // Every shortcut that jumps to the Sales Counter (a barcode scanned on another tab, "add to cart" from a booking,
            // prescription or production screen) goes through here, so it can never open the till for someone who was not given it.
            const btn = document.getElementById('sales-tab-btn');
            if (typeof isTabLocked === 'function' && isTabLocked('sales-tab')) {
                if (typeof showToast === 'function') showToast('The Sales Counter is not one of your tabs. Ask the admin to give it to you.', true);
                return false;
            }
            const tab = document.getElementById('sales-tab');
            if (tab && !tab.classList.contains('active')) performTabSwitch(btn, 'sales-tab');
            return true;
        }

//@fn scannerStripFromField
function scannerStripFromField(code) {
            // A keyboard-wedge scanner types into whatever field has the cursor. A scan made while the cursor sat in "cash tendered",
            // a quantity or a price used to leave the barcode's digits in that field (e.g. cash = 5901234123457) as well as adding the
            // item. The scanned characters are taken back out of such a field. The Sales Counter search is simply cleared, and a field
            // made for codes (barcode, search, reference) keeps what was scanned into it. (zip 143)
            try {
                const ae = document.activeElement;
                if (!ae || !/^(INPUT|TEXTAREA)$/.test(ae.tagName) || !code) return;
                if (ae.id === 'sales-search') { ae.value = ''; if (typeof liveSearch === 'function') liveSearch(''); return; }
                if (/code|barcode|scan|search|ref|sku/i.test(`${ae.id} ${ae.name || ''} ${ae.placeholder || ''}`)) return;
                const v = String(ae.value || '');
                if (v.endsWith(code)) { ae.value = v.slice(0, v.length - code.length); ae.dispatchEvent(new Event('input', { bubbles: true })); }
                else if (ae.type === 'number' && /^\d+$/.test(code) && v.replace(/\D/g, '').endsWith(code)) { ae.value = ''; ae.dispatchEvent(new Event('input', { bubbles: true })); }
            } catch (e) { /* cosmetic */ }
        }

//@fn inventoryHasExactCode
function inventoryHasExactCode(code) {
            // Same matching rules as scanToCart: the item code, a dual-unit piece code, or a variant's own (box/piece) code.
            const c = String(code || '').trim().toLowerCase();
            if (!c || !Array.isArray(inventory)) return false;
            return inventory.some((p) => p && ((p.code && String(p.code).toLowerCase() === c)
                || (p.pieceCode && String(p.pieceCode).toLowerCase() === c)
                || (Array.isArray(p.variants) && p.variants.some((v) => v && ((v.code && String(v.code).toLowerCase() === c) || (v.dualUnit && v.pieceCode && String(v.pieceCode).toLowerCase() === c))))));
        }

//@fn netFailReason
function netFailReason() {
            // zip 143 — the real reason a request failed, instead of "check your connection" for every failure (a server error, an
            // expired session, a refused action, a slow answer). The connectivity manager's own verdict first (it checks /api/health and,
            // only if that fails, the internet itself), then how the last API call actually failed.
            try {
                const net = window.PosNet;
                if (net && net.state === 'offline') return 'this device is offline. Selling still works — this will work again when the internet is back.';
                const f = window.__apiLastFail;
                if (f && Date.now() - f.at < 20000) {
                    if (f.kind === 'timeout') return 'the server took too long to answer. Your internet works — try again in a moment.';
                    if (f.kind === 'network') {
                        if (net) net.check('request failed');
                        if (net && net.state === 'backend_unavailable') return 'your internet works, but the MyDukaPOS server is not answering. Try again in a moment.';
                        if (net && net.state === 'online') return 'the request did not get through (the connection dropped for a moment) — try again.';
                        return 'could not reach the server — check this device\'s internet connection.';
                    }
                    if (f.status === 401) return 'this device or your staff sign-in must be confirmed again (sign in with your PIN, or pair the device in Settings ▸ Devices & Security).';
                    if (f.status === 403) return 'not allowed — this shop\'s link is not active, or your account may not do this.';
                    if (f.status === 404) return 'not found on the server — refresh and try again.';
                    if (f.status === 413) return 'too large to send in one go.';
                    if (f.status === 429) return 'too many requests at once — wait a little and try again.';
                    if (f.status >= 500) return `the server had a problem (error ${f.status}). Your internet works — try again in a moment.`;
                    if (f.status) return `the server refused the request (error ${f.status}).`;
                }
                if (net && net.state === 'backend_unavailable') return 'your internet works, but the MyDukaPOS server is not answering. Try again in a moment.';
                if (net && net.state === 'auth_required') return 'this device must be paired or signed in again before it can do this.';
                return 'something went wrong — try again. (Your connection looks fine.)';
            } catch (e) { return 'something went wrong — try again.'; }
        }

//@fn netErrText
function netErrText(what) {
            if (what === 'Could not reach the server') { const r = netFailReason(); return r.charAt(0).toUpperCase() + r.slice(1); }
            return `${what}: ${netFailReason()}`;
        }

//@fn netErrMsg
function netErrMsg(e, what) {
            // A message the server itself sent is kept; a browser's own network error text ("Failed to fetch") is not.
            const m = e && e.message;
            if (m && e.name !== 'TypeError' && e.name !== 'AbortError' && e.name !== 'SyntaxError' && !/failed to fetch|networkerror|load failed|network request failed/i.test(m)) return m;
            return netErrText(what);
        }

//@fn devicePaperWidth
function devicePaperWidth() {
            // zip 144 — THIS device's own printer paper ('' = follow the shop's Receipt Settings). The shop setting is synced to every till
            // (and shared between branches), but each till has its own printer: a till with a 58 mm printer in a shop set to 80 mm got
            // every line laid out 48 characters wide, and the PRINTER wrapped each one at 32 — broken words, "350.00 A" on a line of its own.
            try { return localStorage.getItem('pos_device_paper_mm') || ''; } catch (e) { return ''; }
        }

//@fn receiptPaperMm
function receiptPaperMm() {
            // The paper width every receipt, bill, ticket and report on this device is laid out for (mm).
            const dev = parseFloat(devicePaperWidth());
            if (dev >= 30 && dev <= 120) return dev;
            const rw = typeof receiptWidth !== 'undefined' ? receiptWidth : '80';
            const cw = typeof receiptCustomWidth !== 'undefined' ? receiptCustomWidth : '';
            const mm = rw === 'custom' ? (parseFloat(cw) || 80) : (parseFloat(rw) || 80);
            return Math.max(30, Math.min(120, mm));
        }

//@fn receiptPrintableMm
function receiptPrintableMm(paperMm) {
            // What the print head can actually reach: 58 mm paper prints 48 mm (384 dots at 203 dpi), 80 mm prints 72 mm (576 dots).
            // Laying a receipt out on the full paper width is what pushed its right edge off the head (clipped / scaled-down print).
            const mm = paperMm || receiptPaperMm();
            if (mm <= 58) return Math.max(26, mm - 10);
            if (mm >= 80) return mm - 8;
            return Math.round((48 + (mm - 58) * (24 / 22)) * 10) / 10;
        }

//@fn setDevicePaperWidth
function setDevicePaperWidth(value) {
            // '' = use the shop's setting; '58' / '80' / a width in mm = this device's printer. Kept on this device only (never synced).
            const v = String(value == null ? '' : value).trim();
            const n = parseFloat(v);
            try {
                if (!v || !(n >= 30 && n <= 120)) localStorage.removeItem('pos_device_paper_mm');
                else localStorage.setItem('pos_device_paper_mm', String(n));
            } catch (e) { /* private mode: this session only */ }
            if (typeof syncDevicePaperWidthUI === 'function') syncDevicePaperWidthUI();
            // an open receipt is laid out again for the new paper at once (the preview is always what will print)
            try {
                const modal = document.getElementById('receipt-modal');
                if (modal && modal.style.display === 'flex' && typeof currentReceiptSale !== 'undefined' && currentReceiptSale
                    && typeof renderReceipt === 'function' && Array.isArray(currentReceiptSale.items)) {
                    window.__receiptRelayoutOnly = true;
                    try { renderReceipt(currentReceiptSale); } finally { window.__receiptRelayoutOnly = false; }
                }
            } catch (e) { /* the next receipt uses it */ }
            receiptApplyPaperVars();
            if (typeof showToast === 'function') showToast(`This device's printer: ${receiptPaperMm()} mm paper (${getPaperCols()} characters a line).`);
        }

//@fn syncDevicePaperWidthUI
function syncDevicePaperWidthUI() {
            const dev = devicePaperWidth();
            document.querySelectorAll('[data-device-paper]').forEach((b) => {
                const on = (b.dataset.devicePaper || '') === (dev === '58' || dev === '80' ? dev : (dev ? 'custom' : ''));
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            document.querySelectorAll('.device-paper-now').forEach((el) => {
                el.textContent = `${receiptPaperMm()} mm paper · ${getPaperCols()} characters a line${dev ? '' : ' (shop setting)'}`;
            });
        }

//@fn receiptApplyPaperVars
function receiptApplyPaperVars() {
            // The on-screen paper is the real paper: same width, same printable area, same characters per line as the print.
            try {
                const paper = receiptPaperMm(), printable = receiptPrintableMm(paper);
                const s = document.body.style;
                s.setProperty('--rg-paper', paper + 'mm');
                s.setProperty('--rg-side', ((paper - printable) / 2).toFixed(2) + 'mm');
                s.setProperty('--rg-printable-px', String(printable * 96 / 25.4));
            } catch (e) { /* cosmetic */ }
        }

//@fn ensureReceiptGridCss
function ensureReceiptGridCss() {
            if (document.getElementById('receipt-grid-css')) return;
            const st = document.createElement('style');
            st.id = 'receipt-grid-css';
            // One layout for screen and print: a monospaced character grid, cols characters wide, sized so that exactly `cols`
            // characters fill the printable width. Lines are laid out (and wrapped at word boundaries) BEFORE they reach the browser,
            // so the browser never wraps anything itself — the old pre-wrap + word-break layout at a fixed 12-13 px is what split
            // words and numbers ("350." / "00") on narrow paper.
            st.textContent = [
                '.receipt-grid{font-family:"Courier New",Courier,"Liberation Mono","Nimbus Mono PS","DejaVu Sans Mono","Roboto Mono","Droid Sans Mono",monospace !important;',
                'font-size:var(--rg-font,11px) !important;line-height:1.28 !important;white-space:pre;width:calc(var(--rg-cols,32) * 1ch);margin:0 auto;text-align:left;',
                'word-break:normal;overflow-wrap:normal;letter-spacing:0;font-variant-ligatures:none;font-kerning:none;color:#000;}',
                // the apps set a proportional font on EVERY element (* { font-family: Segoe UI … }): the lines must take the grid's own
                '.receipt-grid .rg-l{white-space:pre;min-height:1.28em;overflow:visible;font-family:inherit !important;font-size:inherit !important;line-height:inherit !important;letter-spacing:0 !important;}',
                '.receipt-grid .rg-b{font-weight:700;}',
                '.receipt-grid-barcode{text-align:center;margin:6px 0 2px;}',
                '.receipt-grid-barcode svg{max-width:100%;height:auto;}',
                '#receipt-modal .receipt-paper,#kitchen-ticket-modal .receipt-paper{box-sizing:border-box;width:var(--rg-paper,80mm);padding-left:var(--rg-side,4mm);padding-right:var(--rg-side,4mm);}',
                '.device-paper-picker{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 8px;font-size:12px;}',
                '.device-paper-picker button{padding:4px 10px;border-radius:14px;border:1px solid #bbb;background:#fff;color:#333;cursor:pointer;}',
                '.device-paper-picker button.active{background:#2c3e50;color:#fff;border-color:#2c3e50;}',
                '@media print{',
                'body.printing-receipt .receipt-paper,body.printing-kitchen-ticket .receipt-paper{box-sizing:border-box !important;width:var(--rg-paper,80mm) !important;padding-left:var(--rg-side,4mm) !important;padding-right:var(--rg-side,4mm) !important;}',
                'body.printing-receipt .receipt-paper.align-left{padding-left:max(0mm, calc(var(--rg-side,4mm) - 3mm)) !important;padding-right:calc(var(--rg-side,4mm) + 3mm) !important;}',
                'body.printing-receipt .receipt-paper.align-right{padding-left:calc(var(--rg-side,4mm) + 3mm) !important;padding-right:max(0mm, calc(var(--rg-side,4mm) - 3mm)) !important;}',
                'body.printing-receipt .receipt-grid,body.printing-kitchen-ticket .receipt-grid{font-size:var(--rg-font,11px) !important;}',
                '.device-paper-picker{display:none !important;}',
                '}',
            ].join('');
            document.head.appendChild(st);
        }

//@fn receiptGridSafe
function receiptGridSafe(s) {
            // One character = one column: tabs become a space; zero-width characters and emoji (drawn two columns wide, and not in a
            // thermal printer's font) are removed so they can never push a column out of line.
            return String(s == null ? '' : s).replace(/\t/g, ' ')
                .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
                .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
                .replace(/[\uD800-\uDFFF]/g, '');
        }

//@fn receiptGridLines
function receiptGridLines(lines, align, cols) {
            // The ONE line-layout step, shared by the preview, the system print dialog, the PDF and (through thermalPrepareText) the
            // USB / Bluetooth printers: every line is fitted to `cols` characters and wrapped at word boundaries, never inside a word or
            // a number, never leaving "KES" without its amount. Centre / right alignment is done with spaces, exactly as a printer does.
            cols = cols || getPaperCols();
            const out = [];
            (Array.isArray(lines) ? lines : String(lines == null ? '' : lines).split('\n')).forEach((raw) => {
                String(raw == null ? '' : raw).replace(/\r/g, '').split('\n').forEach((one) => {
                    const fitted = thermalFitLegacyWidth(receiptGridSafe(one), cols);
                    thermalWrapLine(fitted, cols).forEach((l) => {
                        let t = l;
                        if (align === 'center' && t.trim() && !/^-+$/.test(t.trim())) { t = t.trim(); t = ' '.repeat(Math.max(0, Math.floor((cols - t.length) / 2))) + t; }
                        else if (align === 'right' && t.trim()) t = t.trim().padStart(cols);
                        out.push(t);
                    });
                });
            });
            return out;
        }

//@fn receiptGridHtml
function receiptGridHtml(blocks, opts) {
            // blocks: [{ lines, align: 'left'|'center'|'right', bold(line, index) }]. Returns the grid, cols characters wide.
            opts = opts || {};
            const cols = opts.cols || getPaperCols();
            ensureReceiptGridCss();
            receiptApplyPaperVars();
            const fontPx = (receiptPrintableMm() * 96 / 25.4) / (cols * 0.6);   // refined by fitReceiptGrids() once measurable
            let html = `<div class="receipt-grid" data-cols="${cols}" style="--rg-cols:${cols}; --rg-font:${fontPx.toFixed(2)}px;">`;
            (blocks || []).forEach((b) => {
                if (!b) return;
                receiptGridLines(b.lines || [], b.align || 'left', cols).forEach((l, i) => {
                    const bold = typeof b.bold === 'function' ? !!b.bold(l, i) : false;
                    html += `<div class="rg-l${bold ? ' rg-b' : ''}">${escapeHtml(l)}</div>`;
                });
            });
            html += '</div>';
            if (!window.__rgFitScheduled) {
                window.__rgFitScheduled = true;
                const run = () => { window.__rgFitScheduled = false; fitReceiptGrids(); };
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 0);
            }
            return html;
        }

//@fn fitReceiptGrids
function fitReceiptGrids(root) {
            // Fonts differ between devices (Courier New on Windows, another monospace on Android): measure the real character width
            // and size the text so that exactly `cols` characters fill the printable width. Nothing to measure while hidden (the
            // first estimate, 0.6 em per character, then stands) — it runs again on every print.
            try {
                const target = receiptPrintableMm() * 96 / 25.4;
                (root || document).querySelectorAll('.receipt-grid').forEach((g) => {
                    const w = g.getBoundingClientRect ? g.getBoundingClientRect().width : 0;
                    if (!(w > 0)) return;
                    const cur = parseFloat(g.style.getPropertyValue('--rg-font')) || 11;
                    const next = cur * (target * 0.995) / w;
                    if (Math.abs(next - cur) > 0.01) g.style.setProperty('--rg-font', next.toFixed(3) + 'px');
                });
            } catch (e) { /* the estimate stands */ }
        }

//@fn setPrintBodyText
function setPrintBodyText(el, text, opts) {
            // Any plain-text document (kitchen ticket, order slip, invoice, statement) shown in a print window: the same grid as receipts.
            if (!el) return;
            opts = opts || {};
            el.innerHTML = receiptGridHtml([{ lines: String(text == null ? '' : text).split('\n'), align: opts.align || 'left', bold: opts.bold || ((l, i) => i === 0 && !!l.trim()) }]);
        }

//@fn receiptMoneyRow
function receiptMoneyRow(label, value, cols) {
            // "LABEL ............ KES 1,234.00": the amount always on the right edge, never split, never colliding with the label.
            cols = cols || getPaperCols();
            label = String(label); value = String(value);
            if (label.length + 1 + value.length <= cols) return [label + ' '.repeat(cols - label.length - value.length) + value];
            return [label, value.padStart(cols)];
        }

//@fn printPaperWidthTest
async function printPaperWidthTest() {
            // Prints two rulers straight to a USB / Bluetooth printer, with no fitting: the 32-character one always fits; if the
            // 48-character one breaks onto a second line the printer is 58 mm. This is how to find out what a printer really holds.
            const msgEl = document.getElementById('device-paper-test-msg');
            const say = (t, err) => { if (msgEl) { msgEl.className = err ? 'settings-msg error' : 'settings-msg success'; msgEl.textContent = t; } else if (typeof showToast === 'function') showToast(t, !!err); };
            const r32 = '12345678901234567890123456789012', r48 = r32 + '3456789012345678';
            const text = ['PAPER WIDTH TEST', '', '32 characters:', r32, '', '48 characters:', r48, '', 'If the 48 line broke in two:', 'choose 58 mm.', 'If it printed on one line:', 'choose 80 mm.', '', '', ''].join('\n');
            const bytes = new Uint8Array([0x1B, 0x40, 0x1B, 0x4D, 0x00, ...new TextEncoder().encode(text), 0x1D, 0x56, 0x42, 0x00]);
            try {
                if (printerMode === 'bluetooth' && typeof btPrinterCharacteristic !== 'undefined' && btPrinterCharacteristic) { await sendBytesViaBluetooth(bytes); say('Test sent over Bluetooth — see the note on the paper.'); return; }
                if (printerMode === 'usb' && typeof usbPrinterDevice !== 'undefined' && usbPrinterDevice && usbPrinterEndpoint !== null) { await sendBytesViaUSB(bytes); say('Test sent over USB — see the note on the paper.'); return; }
                say('Connect a USB or Bluetooth printer first (Settings ▸ Hardware). With the system print dialog, the receipt preview shows exactly what will print.', true);
            } catch (e) { say('The test could not be sent: ' + (e && e.message ? e.message : e), true); }
        }

//@fn receiptPageRule
function receiptPageRule(widthMm, contentEl, fixedLengthMm) {
            // zip 144 — "@page { size: 58mm auto }" is NOT valid CSS (a length and `auto` cannot be mixed), so browsers dropped the whole
            // size and printed on their default paper — A4 / Letter — shrinking the receipt into a corner or across pages. The page is
            // now the roll's width and exactly as long as the document (measured), or the fixed length set in Receipt Settings.
            const w = Math.round((Number(widthMm) || receiptPaperMm()) * 100) / 100;
            let h = Number(fixedLengthMm) > 0 ? Number(fixedLengthMm) : 0;
            if (!h) {
                let px = 0;
                try {
                    px = contentEl ? Math.max(contentEl.scrollHeight || 0, contentEl.getBoundingClientRect ? contentEl.getBoundingClientRect().height : 0) : 0;
                    // the on-screen buttons, the paper picker and the close button do not print: they are not paper to feed
                    if (px > 0) contentEl.querySelectorAll('.receipt-actions, .device-paper-picker, .universal-modal-x').forEach((x) => { px -= x.getBoundingClientRect().height || 0; });
                } catch (e) { px = 0; }
                if (!(px > 0) && contentEl) {
                    // not on screen (a kitchen / order slip prints without its window open): estimate from its lines, never a whole A4 of paper
                    try {
                        const grid = contentEl.querySelector('.receipt-grid');
                        let rows = contentEl.querySelectorAll('.rg-l').length;
                        if (!rows) rows = String(contentEl.textContent || '').split('\n').filter((l) => l.trim()).length;
                        const fontPx = (grid && parseFloat(grid.style.getPropertyValue('--rg-font'))) || 11;
                        if (rows > 0) px = rows * fontPx * 1.28 + (contentEl.querySelector('.receipt-grid-barcode') ? 60 : 0) + 30;
                    } catch (e) { px = 0; }
                }
                h = px > 0 ? Math.ceil(px * 25.4 / 96) + 8 : 297;             // nothing to go on at all: an A4-long strip, cut after the last line
            }
            h = Math.max(40, Math.min(5000, h));
            return `@page { size: ${w}mm ${h}mm; margin: 0; }`;
        }
