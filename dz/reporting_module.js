// ============================================================================
// МОДУЛЬ ОБЛІКУ ЗАНЯТЬ, ВІДВІДУВАНОСТІ, ПРОГРЕСУ ТА ЗВІТНОСТІ (ПЛАГІН)
// Підключається до існуючого журналу одним рядком перед </body>.
// НЕ змінює і НЕ видаляє жодних існуючих даних журналу.
// Усі нові дані зберігаються в окремій гілці Firebase: journal_edu_reporting
// Реквізити для друку зберігаються виключно локально в браузері (localStorage).
// ============================================================================
(function() {
    'use strict';

    if (window.__eduReportingModuleLoaded) return;
    window.__eduReportingModuleLoaded = true;

    const REPORTING_DB_ROOT = 'journal_edu_reporting';
    const LOCAL_SETTINGS_KEY = 'edu_reporting_local_print_settings_v1';

    let repData = {
        lessons: {},       // { id: { date, startTime, endTime, durationMin, subject, group, topic, attendees, status, pauseStart, pauseEnd, notes, addedAt } }
        ktpMeta: {},       // { group__subject: { gaps, methodology, target, addedAt } }
        ktpItems: {},      // { id: { group, subject, num, date, hours, topic, outcomes, checkMethod, addedAt } }
        schedule: {},      // { period, platform, notes, datesText, rows: [...], addedAt }
        studentMeta: {},   // { id: { studentName, categoryId, code, grade, groupLabel, absenceNote, addedAt } }
        progressCards: {}, // { id: { code, grade, groupLabel, linkedStudent, linkedCategory, period, langLevel, attText, uaGaps, mathGaps, uaScores, mathScores, achievedGoals, hardTopics, recommendations, finished, addedAt } }
        reportDrafts: {}   // { interim: {...}, final: {...} }
    };

    let activeSubTab = 'lessons';
    let editingLessonId = null;
    let editingKtpId = null;
    let currentCardId = null;

    const SUBJECTS = ['Українська мова', 'Математика'];
    const DEFAULT_GROUPS = ['Група 1 (1–2 класи)', 'Група 2 (3–4 класи)'];
    const UA_COMPETENCIES = [
        { key: 'reading', label: 'Читання та розуміння прочитаного' },
        { key: 'writing', label: 'Письмо та грамотність' },
        { key: 'rules', label: 'Засвоєння базових мовних правил' },
        { key: 'speaking', label: 'Словниковий запас та усне мовлення' }
    ];
    const MATH_COMPETENCIES = [
        { key: 'calc', label: 'Навички обчислення' },
        { key: 'concepts', label: 'Основні математичні поняття' },
        { key: 'problems', label: 'Розв’язування прикладів і задач' },
        { key: 'logic', label: 'Логічне мислення та розуміння інструкцій' }
    ];

    function getLocalSettings() {
        const defaults = {
            docBasis: '',
            periodLabel: '',
            hourlyRate: 800,
            budgetLimit: '',
            executorTitle: '',
            executorDetails: '',
            executorSigner: '',
            clientTitle: '',
            clientDetails: '',
            clientSigner: '',
            invoiceNum: '1'
        };
        try {
            const saved = JSON.parse(localStorage.getItem(LOCAL_SETTINGS_KEY) || '{}');
            return Object.assign({}, defaults, saved);
        } catch (e) {
            return defaults;
        }
    }

    function saveLocalSettingsObj(obj) {
        localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(obj));
    }

    function esc(str) {
        return typeof window.escapeHtml === 'function'
            ? window.escapeHtml(str)
            : String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escJs(str) {
        return typeof window.escapeJsStr === 'function'
            ? window.escapeJsStr(str)
            : String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    function todayYYYYMMDD() {
        if (typeof window.formatLocalYYYYMMDD === 'function') return window.formatLocalYYYYMMDD(new Date());
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function formatDMY(yyyyMmDd) {
        if (!yyyyMmDd || yyyyMmDd.length < 10) return yyyyMmDd || '—';
        const [y, m, d] = yyyyMmDd.slice(0, 10).split('-');
        return `${d}.${m}.${y}`;
    }

    function parseNum(val) {
        if (val === null || val === undefined || String(val).trim() === '') return null;
        const m = String(val).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
        return m ? parseFloat(m[0]) : null;
    }

    function getAvailableGroupOptions() {
        const set = new Set(DEFAULT_GROUPS);
        if (typeof classesData !== 'undefined' && classesData) {
            Object.keys(classesData).sort((a, b) => (classesData[a].name || '').localeCompare(classesData[b].name || '')).forEach(cid => {
                if (classesData[cid] && classesData[cid].name) set.add(classesData[cid].name);
            });
        }
        Object.values(repData.lessons || {}).forEach(l => { if (l && l.group) set.add(l.group); });
        Object.values(repData.progressCards || {}).forEach(c => { if (c && c.groupLabel) set.add(c.groupLabel); });
        return Array.from(set);
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .rep-subtabs {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
                margin-bottom: 18px;
                padding-bottom: 12px;
                border-bottom: 1px solid #334155;
            }
            .rep-subtab-btn {
                padding: 9px 15px;
                background: #0f172a;
                color: #94a3b8;
                border: 1px solid #334155;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
                font-weight: bold;
                transition: all 0.2s;
            }
            .rep-subtab-btn:hover { background: #334155; color: #f8fafc; box-shadow: none; }
            .rep-subtab-btn.active {
                background: #0ea5e9;
                color: #ffffff;
                border-color: #38bdf8;
                box-shadow: 0 0 12px rgba(14, 165, 233, 0.35);
            }
            .rep-panel { display: none; }
            .rep-panel.active { display: block; }
            .rep-card {
                background: #0f172a;
                border: 1px solid #334155;
                border-radius: 10px;
                padding: 18px;
                margin-bottom: 18px;
            }
            .rep-card h3 {
                margin: 0 0 12px 0;
                color: #38bdf8;
                font-size: 17px;
            }
            .rep-form-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(185px, 1fr));
                gap: 12px;
                margin-bottom: 12px;
            }
            .rep-field {
                display: flex;
                flex-direction: column;
                gap: 5px;
            }
            .rep-field label {
                font-size: 12px;
                color: #94a3b8;
                font-weight: bold;
            }
            .rep-field input, .rep-field select, .rep-field textarea {
                width: 100%;
                box-sizing: border-box;
                padding: 9px 11px;
                border: 1px solid #475569;
                border-radius: 6px;
                background: #1e293b;
                color: #f8fafc;
                font-family: inherit;
                font-size: 13px;
            }
            .rep-field textarea { resize: vertical; min-height: 62px; }
            .rep-field input:focus, .rep-field select:focus, .rep-field textarea:focus {
                outline: none;
                border-color: #38bdf8;
            }
            .rep-kpi-row {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
                gap: 12px;
                margin-bottom: 16px;
            }
            .rep-kpi {
                background: #0f172a;
                border: 1px solid #334155;
                border-radius: 8px;
                padding: 12px 15px;
            }
            .rep-kpi .k-lbl { font-size: 12px; color: #94a3b8; }
            .rep-kpi .k-val { font-size: 21px; font-weight: bold; color: #f8fafc; margin-top: 4px; }
            .rep-badge {
                display: inline-block;
                padding: 3px 8px;
                border-radius: 4px;
                font-size: 11px;
                font-weight: bold;
            }
            .rep-badge.ok { background: rgba(16,185,129,0.2); color: #34d399; }
            .rep-badge.warn { background: rgba(245,158,11,0.2); color: #fbbf24; }
            .rep-badge.err { background: rgba(239,68,68,0.2); color: #f87171; }
            .rep-badge.info { background: rgba(56,189,248,0.2); color: #38bdf8; }
            .rep-actions-bar {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 12px;
            }
            .rep-btn-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
            .rep-progress-bar-bg {
                width: 100%;
                height: 10px;
                background: #1e293b;
                border-radius: 6px;
                overflow: hidden;
                border: 1px solid #334155;
                margin-top: 6px;
            }
            .rep-progress-bar-fill {
                height: 100%;
                background: linear-gradient(90deg, #10b981, #38bdf8);
                transition: width 0.3s;
            }
            .rep-note-banner {
                background: rgba(56, 189, 248, 0.1);
                border: 1px solid rgba(56, 189, 248, 0.35);
                color: #bae6fd;
                padding: 10px 14px;
                border-radius: 8px;
                font-size: 13px;
                margin-bottom: 14px;
                line-height: 1.45;
            }
            .rep-table-scroll {
                width: 100%;
                overflow-x: auto;
            }
            .rep-comp-table input {
                width: 78px;
                padding: 6px 8px;
                text-align: center;
                font-size: 13px;
            }
            @media print {
                .rep-page-break { page-break-after: always; }
            }
        `;
        document.head.appendChild(style);
    }

    function injectDOM() {
        const tabsBar = document.querySelector('.tabs');
        const container = document.querySelector('.container');
        if (!tabsBar || !container) return;

        // 1. Вкладка в головному меню
        const tabBtn = document.createElement('button');
        tabBtn.className = 'tab-btn';
        tabBtn.id = 'tab-btn-reporting';
        tabBtn.type = 'button';
        tabBtn.innerHTML = '📑 Облік і Звіти';
        tabBtn.onclick = function() {
            if (typeof window.switchTab === 'function') {
                window.switchTab('reporting', tabBtn);
            }
        };
        const backupBtn = tabsBar.querySelector('.backup-main-btn');
        if (backupBtn) {
            tabsBar.insertBefore(tabBtn, backupBtn);
        } else {
            tabsBar.appendChild(tabBtn);
        }

        // 2. Контейнер вкладки
        const tabContent = document.createElement('div');
        tabContent.id = 'tab-reporting';
        tabContent.className = 'tab-content';
        tabContent.innerHTML = `
            <div class="rep-subtabs">
                <button type="button" class="rep-subtab-btn active" data-sub="lessons">📖 Журнал занять</button>
                <button type="button" class="rep-subtab-btn" data-sub="attendance_reg">📋 Реєстр відвідуваності (коди)</button>
                <button type="button" class="rep-subtab-btn" data-sub="progress">📈 Картки прогресу</button>
                <button type="button" class="rep-subtab-btn" data-sub="ktp">🗓️ Графік і КТП</button>
                <button type="button" class="rep-subtab-btn" data-sub="reports">📄 Звіти та Рахунок</button>
                <button type="button" class="rep-subtab-btn" data-sub="backup">🛡️ Повний бекап</button>
            </div>

            <!-- 1. ЖУРНАЛ ПРОВЕДЕНИХ ЗАНЯТЬ -->
            <div id="rep-sub-lessons" class="rep-panel active">
                <div class="rep-kpi-row" id="rep-lessons-kpi"></div>

                <div class="rep-card">
                    <div class="rep-actions-bar" style="margin-bottom:10px;">
                        <h3 id="rep-lesson-form-title" style="margin:0;">➕ Записати проведене заняття</h3>
                        <button type="button" class="btn-slate" id="rep-lesson-cancel-edit" style="display:none; padding:6px 12px; font-size:12px;">Скасувати редагування</button>
                    </div>
                    <div class="rep-form-grid">
                        <div class="rep-field">
                            <label>Дата заняття</label>
                            <input type="date" id="rep-l-date">
                        </div>
                        <div class="rep-field">
                            <label>Початок</label>
                            <input type="time" id="rep-l-start" value="15:00">
                        </div>
                        <div class="rep-field">
                            <label>Кінець</label>
                            <input type="time" id="rep-l-end" value="16:00">
                        </div>
                        <div class="rep-field">
                            <label>Факт. тривалість (хв)</label>
                            <input type="number" id="rep-l-dur" value="60" min="0" step="5">
                        </div>
                        <div class="rep-field">
                            <label>Предмет</label>
                            <select id="rep-l-subject">
                                <option value="Українська мова">Українська мова</option>
                                <option value="Математика">Математика</option>
                            </select>
                        </div>
                        <div class="rep-field">
                            <label>Навчальна група</label>
                            <select id="rep-l-group"></select>
                        </div>
                        <div class="rep-field">
                            <label>К-сть присутніх учнів</label>
                            <div style="display:flex; gap:6px;">
                                <input type="number" id="rep-l-att" value="0" min="0" max="50">
                                <button type="button" id="rep-l-sync-att" class="btn-slate" style="padding:6px 10px; font-size:12px; white-space:nowrap;" title="Підрахувати присутніх із вкладки Відвідуваність за цю дату">🔄 З табеля</button>
                            </div>
                        </div>
                        <div class="rep-field">
                            <label>Статус заняття</label>
                            <select id="rep-l-status">
                                <option value="conducted">✅ Проведено за графіком</option>
                                <option value="paused">⚠️ Проведено (була безпекова пауза)</option>
                                <option value="noshow_paid">🕒 Неявка учнів без попередження (оплачується)</option>
                                <option value="rescheduled">🔁 Перенесено (не входить у години)</option>
                                <option value="cancelled">❌ Скасовано (не входить у години)</option>
                            </select>
                        </div>
                    </div>

                    <div id="rep-l-pause-box" class="rep-form-grid" style="display:none; background:#1e293b; padding:10px; border-radius:8px; border:1px dashed #f59e0b;">
                        <div class="rep-field">
                            <label style="color:#fbbf24;">Час призупинення (тривога / загроза)</label>
                            <input type="time" id="rep-l-pstart">
                        </div>
                        <div class="rep-field">
                            <label style="color:#fbbf24;">Час відновлення заняття</label>
                            <input type="time" id="rep-l-pend">
                        </div>
                    </div>

                    <div class="rep-form-grid" style="grid-template-columns: 2fr 1fr;">
                        <div class="rep-field">
                            <label>Тема та короткий опис опрацьованого матеріалу</label>
                            <input type="text" id="rep-l-topic" placeholder="Напр.: Повторення таблиці множення, розв’язування текстових задач...">
                        </div>
                        <div class="rep-field">
                            <label>Примітки (перенесення, скасування, деталі)</label>
                            <input type="text" id="rep-l-notes" placeholder="Необов’язково">
                        </div>
                    </div>
                    <div class="rep-btn-row">
                        <button type="button" id="rep-l-save-btn" class="btn-blue">💾 Зберегти заняття</button>
                    </div>
                </div>

                <div class="rep-card">
                    <div class="rep-actions-bar">
                        <div class="rep-btn-row">
                            <input type="month" id="rep-l-filter-month" title="Фільтр за місяцем">
                            <button type="button" id="rep-l-filter-allmonths" class="btn-slate" style="padding:8px 12px; font-size:12px;">Усі місяці</button>
                            <select id="rep-l-filter-group"><option value="all">Усі групи</option></select>
                            <select id="rep-l-filter-subject">
                                <option value="all">Усі предмети</option>
                                <option value="Українська мова">Українська мова</option>
                                <option value="Математика">Математика</option>
                            </select>
                        </div>
                        <div class="rep-btn-row">
                            <button type="button" id="rep-l-print-btn" class="btn-purple" style="padding:8px 13px; font-size:13px;">🖨️ Друк Журналу (А4 / PDF)</button>
                            <button type="button" id="rep-l-csv-btn" style="padding:8px 13px; font-size:13px;">📗 Excel (CSV)</button>
                        </div>
                    </div>
                    <div class="rep-table-scroll" id="rep-lessons-table-wrap"></div>
                </div>
            </div>

            <!-- 2. РЕЄСТР ВІДВІДУВАНОСТІ (ЗНЕОСОБЛЕНИЙ З КОДАМИ) -->
            <div id="rep-sub-attendance_reg" class="rep-panel">
                <div class="rep-note-banner">
                    Цей реєстр <b>автоматично бере відмітки</b> з вашої вкладки «📅 Відвідуваність» і підставляє анонімні <b>коди учнів</b> (наприклад, <code>G1-01</code>) замість імен. Імена бачите тільки ви у робочому режимі; у друк та Excel для зовнішньої звітності потрапляють лише коди.
                </div>
                <div class="rep-card">
                    <div class="rep-actions-bar">
                        <div class="rep-btn-row">
                            <select id="rep-ar-class"></select>
                            <input type="month" id="rep-ar-month">
                            <select id="rep-ar-subject">
                                <option value="Українська мова та математика">Українська мова та математика</option>
                                <option value="Українська мова">Українська мова</option>
                                <option value="Математика">Математика</option>
                            </select>
                            <label style="display:inline-flex; align-items:center; gap:6px; font-size:13px; color:#cbd5e1; cursor:pointer; background:#1e293b; padding:7px 11px; border-radius:6px; border:1px solid #475569;">
                                <input type="checkbox" id="rep-ar-anon" checked style="width:auto; padding:0;">
                                Знеособити (коди)
                            </label>
                        </div>
                        <div class="rep-btn-row">
                            <button type="button" id="rep-ar-autocodes" class="btn-slate" style="padding:8px 12px; font-size:12px;">⚡ Автокоди класу</button>
                            <button type="button" id="rep-ar-print" class="btn-purple" style="padding:8px 13px; font-size:13px;">🖨️ Друк Реєстру (А4 / PDF)</button>
                            <button type="button" id="rep-ar-csv" style="padding:8px 13px; font-size:13px;">📗 Excel (CSV)</button>
                        </div>
                    </div>

                    <details style="margin-bottom:14px; background:#1e293b; border:1px solid #334155; border-radius:8px; padding:10px 14px;">
                        <summary style="cursor:pointer; color:#38bdf8; font-weight:bold; font-size:14px;">🔑 Налаштування кодів, класу та коротких приміток щодо пропусків</summary>
                        <div id="rep-ar-codes-editor" style="margin-top:12px;"></div>
                    </details>

                    <div class="rep-table-scroll" id="rep-ar-table-wrap"></div>
                </div>
            </div>

            <!-- 3. ІНДИВІДУАЛЬНІ КАРТКИ НАВЧАЛЬНОГО ПРОГРЕСУ -->
            <div id="rep-sub-progress" class="rep-panel">
                <div class="rep-card">
                    <div class="rep-actions-bar">
                        <div class="rep-btn-row">
                            <select id="rep-pc-select" style="min-width:240px;"></select>
                            <button type="button" id="rep-pc-new" class="btn-blue" style="padding:8px 13px; font-size:13px;">➕ Нова картка</button>
                            <button type="button" id="rep-pc-sync-class" class="btn-slate" style="padding:8px 12px; font-size:12px;">⚡ Створити картки для класу</button>
                        </div>
                        <div class="rep-btn-row">
                            <button type="button" id="rep-pc-print-one" class="btn-purple" style="padding:8px 13px; font-size:13px;">🖨️ Друк цієї картки (А4)</button>
                            <button type="button" id="rep-pc-print-all" class="btn-purple" style="padding:8px 13px; font-size:13px;">🖨️ Друк усіх карток (А4)</button>
                        </div>
                    </div>

                    <div id="rep-pc-editor-wrap"></div>
                </div>
            </div>

            <!-- 4. ГРАФІК ТА КАЛЕНДАРНО-ТЕМАТИЧНИЙ ПЛАН (КТП) -->
            <div id="rep-sub-ktp" class="rep-panel">
                <div class="rep-card">
                    <div class="rep-actions-bar">
                        <h3 style="margin:0;">🗓️ Погодження графіка та планового обсягу годин</h3>
                        <div class="rep-btn-row">
                            <button type="button" id="rep-sch-save" class="btn-blue" style="padding:8px 13px; font-size:13px;">💾 Зберегти графік</button>
                            <button type="button" id="rep-sch-print" class="btn-purple" style="padding:8px 13px; font-size:13px;">🖨️ Друк графіка (А4 / PDF)</button>
                        </div>
                    </div>
                    <div class="rep-form-grid">
                        <div class="rep-field">
                            <label>Період навчання</label>
                            <input type="text" id="rep-sch-period" placeholder="Напр.: листопад — грудень 2026 р.">
                        </div>
                        <div class="rep-field">
                            <label>Формат і платформа</label>
                            <input type="text" id="rep-sch-platform" placeholder="Напр.: Онлайн (Google Meet / Zoom)">
                        </div>
                        <div class="rep-field">
                            <label>Конкретні дати занять (перелік)</label>
                            <input type="text" id="rep-sch-dates" placeholder="Напр.: 03.11, 05.11, 10.11...">
                        </div>
                    </div>
                    <div id="rep-sch-rows-wrap"></div>
                    <button type="button" id="rep-sch-add-row" class="btn-slate" style="margin-top:8px; padding:7px 12px; font-size:12px;">➕ Додати рядок розкладу</button>
                </div>

                <div class="rep-card">
                    <div class="rep-actions-bar">
                        <h3 style="margin:0;">📚 Календарно-тематичний план (КТП) та методика оцінювання</h3>
                        <div class="rep-btn-row">
                            <select id="rep-ktp-group"></select>
                            <select id="rep-ktp-subject">
                                <option value="Українська мова">Українська мова</option>
                                <option value="Математика">Математика</option>
                            </select>
                            <button type="button" id="rep-ktp-print" class="btn-purple" style="padding:8px 13px; font-size:13px;">🖨️ Друк КТП (А4 / PDF)</button>
                            <button type="button" id="rep-ktp-csv" style="padding:8px 13px; font-size:13px;">📗 Excel (CSV)</button>
                        </div>
                    </div>

                    <div class="rep-form-grid" style="grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));">
                        <div class="rep-field">
                            <label>Виявлені базові прогалини групи (після первинного оцінювання)</label>
                            <textarea id="rep-ktp-gaps" placeholder="Короткий перелік освітніх прогалин..."></textarea>
                        </div>
                        <div class="rep-field">
                            <label>Методика вимірювання навчального прогресу</label>
                            <textarea id="rep-ktp-method" placeholder="Напр.: 100-бальна / 4-рівнева шкала за співставними діагностичними завданнями..."></textarea>
                        </div>
                        <div class="rep-field">
                            <label>Реалістичні цільові показники</label>
                            <textarea id="rep-ktp-target" placeholder="Напр.: підвищення результату щонайменше на 15–20% у 75% учнів..."></textarea>
                        </div>
                    </div>
                    <button type="button" id="rep-ktp-save-meta" class="btn-blue" style="margin-bottom:16px; padding:7px 13px; font-size:12px;">💾 Зберегти опис КТП</button>

                    <div style="border-top:1px solid #334155; padding-top:14px; margin-bottom:12px;">
                        <div class="rep-form-grid">
                            <div class="rep-field" style="max-width:90px;">
                                <label>№</label>
                                <input type="number" id="rep-ktp-num" min="1" value="1">
                            </div>
                            <div class="rep-field">
                                <label>Орієнтовна дата</label>
                                <input type="date" id="rep-ktp-date">
                            </div>
                            <div class="rep-field" style="max-width:100px;">
                                <label>Годин</label>
                                <input type="number" id="rep-ktp-hours" step="0.5" min="0.5" value="1">
                            </div>
                            <div class="rep-field">
                                <label>Тема та зміст заняття</label>
                                <input type="text" id="rep-ktp-topic" placeholder="Назва теми">
                            </div>
                            <div class="rep-field">
                                <label>Очікувані результати</label>
                                <input type="text" id="rep-ktp-outcomes" placeholder="Що вмітиме учень">
                            </div>
                            <div class="rep-field">
                                <label>Спосіб перевірки</label>
                                <input type="text" id="rep-ktp-check" placeholder="Тест / практичні вправи / гра">
                            </div>
                        </div>
                        <div class="rep-btn-row">
                            <button type="button" id="rep-ktp-add-item" class="btn-blue" style="padding:8px 14px; font-size:13px;">➕ Додати рядок у КТП</button>
                            <button type="button" id="rep-ktp-cancel-edit" class="btn-slate" style="display:none; padding:8px 12px; font-size:12px;">Скасувати</button>
                        </div>
                    </div>
                    <div class="rep-table-scroll" id="rep-ktp-table-wrap"></div>
                </div>
            </div>

            <!-- 5. ЗВІТИ ТА РАХУНОК (З ЛОКАЛЬНИМИ РЕКВІЗИТАМИ) -->
            <div id="rep-sub-reports" class="rep-panel">
                <div class="rep-note-banner">
                    🔒 <b>Конфіденційність:</b> реквізити сторін, підстава та суми у блоці нижче зберігаються <b>тільки локально у вашому браузері</b> — вони не записуються у код сторінки і не відправляються у хмарну базу.
                </div>

                <details class="rep-card" style="padding:14px 18px;">
                    <summary style="cursor:pointer; color:#38bdf8; font-weight:bold; font-size:15px;">⚙️ Параметри документів та реквізити для друку (локально на цьому ПК)</summary>
                    <div style="margin-top:14px;">
                        <div class="rep-form-grid">
                            <div class="rep-field">
                                <label>Підстава (номер / дата документа — за потреби)</label>
                                <input type="text" id="rep-set-basis" placeholder="Заповнюється лише для друку">
                            </div>
                            <div class="rep-field">
                                <label>Період надання послуг</label>
                                <input type="text" id="rep-set-period" placeholder="Напр.: листопад — грудень 2026 р.">
                            </div>
                            <div class="rep-field">
                                <label>Ставка за 1 навч. годину (60 хв), грн</label>
                                <input type="number" id="rep-set-rate" min="0" step="10" value="800">
                            </div>
                            <div class="rep-field">
                                <label>Граничний ліміт суми, грн (необов’язково)</label>
                                <input type="number" id="rep-set-limit" min="0" step="100" placeholder="Напр.: 90000">
                            </div>
                        </div>
                        <div class="rep-form-grid" style="grid-template-columns: 1fr 1fr;">
                            <div class="rep-field">
                                <label>Виконавець (назва / ФОП)</label>
                                <input type="text" id="rep-set-exec-title" placeholder="Назва виконавця">
                            </div>
                            <div class="rep-field">
                                <label>Замовник (назва організації)</label>
                                <input type="text" id="rep-set-cli-title" placeholder="Назва замовника">
                            </div>
                            <div class="rep-field">
                                <label>Реквізити Виконавця (для рахунку: IBAN, банк, код, адреса, контакти)</label>
                                <textarea id="rep-set-exec-det" placeholder="Кожен рядок буде красиво виведений у шапці рахунку..."></textarea>
                            </div>
                            <div class="rep-field">
                                <label>Реквізити Замовника (для рахунку: ЄДРПОУ, адреса, IBAN, банк)</label>
                                <textarea id="rep-set-cli-det" placeholder="Кожен рядок буде виведений у блоці Платника..."></textarea>
                            </div>
                            <div class="rep-field">
                                <label>Підпис Виконавця (ПІБ)</label>
                                <input type="text" id="rep-set-exec-sign" placeholder="Ім’я та прізвище">
                            </div>
                            <div class="rep-field">
                                <label>Підпис Замовника (ПІБ, посада — необов’язково)</label>
                                <input type="text" id="rep-set-cli-sign" placeholder="Посада, ПІБ">
                            </div>
                        </div>
                        <div class="rep-btn-row">
                            <button type="button" id="rep-set-save" class="btn-blue" style="padding:8px 14px; font-size:13px;">💾 Зберегти локально на цьому ПК</button>
                            <button type="button" id="rep-set-clear" class="btn-delete" style="padding:8px 12px; font-size:12px;">🧹 Очистити локальні реквізити</button>
                        </div>
                    </div>
                </details>

                <div class="rep-kpi-row" id="rep-budget-kpi"></div>

                <!-- Проміжний звіт -->
                <div class="rep-card">
                    <div class="rep-actions-bar">
                        <h3 style="margin:0;">📊 Проміжний звіт (середина періоду)</h3>
                        <button type="button" id="rep-gen-interim-print" class="btn-purple" style="padding:8px 13px; font-size:13px;">🖨️ Сформувати та друкувати (А4 / PDF)</button>
                    </div>
                    <div class="rep-form-grid" style="grid-template-columns: 1fr 1fr;">
                        <div class="rep-field">
                            <label>Виявлені труднощі (навчальні та організаційні)</label>
                            <textarea id="rep-int-diff" placeholder="Опишіть виявлені складнощі у групах..."></textarea>
                        </div>
                        <div class="rep-field">
                            <label>Вжиті заходи та коригування навчальних планів</label>
                            <textarea id="rep-int-adj" placeholder="Що змінили в методиці або КТП..."></textarea>
                        </div>
                    </div>
                    <button type="button" id="rep-int-save" class="btn-slate" style="padding:7px 12px; font-size:12px;">💾 Зберегти чернетку</button>
                </div>

                <!-- Підсумковий / Місячний звіт -->
                <div class="rep-card">
                    <div class="rep-actions-bar">
                        <h3 style="margin:0;">📑 Підсумковий / Місячний звіт про надання послуг</h3>
                        <div class="rep-btn-row">
                            <select id="rep-fin-period-mode">
                                <option value="all">Увесь період (Підсумковий звіт)</option>
                                <option value="month">Конкретний місяць</option>
                            </select>
                            <input type="month" id="rep-fin-month" style="display:none;">
                            <button type="button" id="rep-gen-final-print" class="btn-purple" style="padding:8px 13px; font-size:13px;">🖨️ Сформувати та друкувати (А4 / PDF)</button>
                        </div>
                    </div>
                    <div class="rep-form-grid" style="grid-template-columns: 1fr 1fr;">
                        <div class="rep-field">
                            <label>Опис прогресу з української мови</label>
                            <textarea id="rep-fin-ua" placeholder="Читання, письмо, граматика, словниковий запас..."></textarea>
                        </div>
                        <div class="rep-field">
                            <label>Опис прогресу з математики</label>
                            <textarea id="rep-fin-math" placeholder="Обчислення, задачі, логічне мислення..."></textarea>
                        </div>
                        <div class="rep-field">
                            <label>Складнощі та заходи реагування (доповнення до автоматичної статистики тривог/перенесень)</label>
                            <textarea id="rep-fin-issues" placeholder="Як вирішувалися організаційні чи навчальні питання..."></textarea>
                        </div>
                        <div class="rep-field">
                            <label>Рекомендації щодо подальшого навчання</label>
                            <textarea id="rep-fin-rec" placeholder="Які теми варто закріплювати далі..."></textarea>
                        </div>
                    </div>
                    <button type="button" id="rep-fin-save" class="btn-slate" style="padding:7px 12px; font-size:12px;">💾 Зберегти чернетку</button>
                </div>

                <!-- Рахунок на оплату -->
                <div class="rep-card">
                    <div class="rep-actions-bar">
                        <h3 style="margin:0;">💳 Рахунок на оплату (автопідрахунок годин із Журналу занять)</h3>
                        <button type="button" id="rep-inv-print" class="btn-blue" style="padding:8px 14px; font-size:13px;">🖨️ Сформувати Рахунок (А4 / PDF)</button>
                    </div>
                    <div class="rep-form-grid">
                        <div class="rep-field">
                            <label>Місяць для рахунку</label>
                            <input type="month" id="rep-inv-month">
                        </div>
                        <div class="rep-field">
                            <label>Номер рахунку</label>
                            <input type="text" id="rep-inv-num" value="1">
                        </div>
                        <div class="rep-field">
                            <label>Дата рахунку</label>
                            <input type="date" id="rep-inv-date">
                        </div>
                        <div class="rep-field">
                            <label>Період у назві послуги (текст)</label>
                            <input type="text" id="rep-inv-period-txt" placeholder="Напр.: листопад 2026 р.">
                        </div>
                    </div>
                    <div id="rep-inv-preview-line" style="font-size:14px; color:#cbd5e1; margin-top:6px;"></div>
                </div>
            </div>

            <!-- 6. ПОВНИЙ БЕКАП УСЬОГО ЖУРНАЛУ -->
            <div id="rep-sub-backup" class="rep-panel">
                <div class="rep-note-banner">
                    🛡️ <b>Повна резервна копія:</b> зберігає в один файл <code>.json</code> на ваш комп’ютер <b>увесь журнал</b> (виконані ігри й відповіді, відвідуваність, учнів, класи, призначення ДЗ, каталог ігор, кошик) <b>+ усі нові дані звітності</b> (журнал занять, КТП, графік, коди учнів, картки прогресу).
                </div>
                <div class="rep-kpi-row" id="rep-backup-stats"></div>
                <div class="backup-cards-grid">
                    <div class="backup-action-card">
                        <div>
                            <h3>📥 1. Завантажити повну копію на комп’ютер</h3>
                            <p style="margin-top:8px;">Створить єдиний файл <b>.json</b> з усіма даними журналу та модуля звітності.</p>
                            <label style="display:inline-flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; margin-top:10px; cursor:pointer;">
                                <input type="checkbox" id="rep-bk-include-local" style="width:auto; padding:0;">
                                Додати також локальні реквізити для друку
                            </label>
                        </div>
                        <button type="button" id="rep-bk-download" style="width:100%; padding:12px; font-size:14px;">📥 Завантажити повну копію (.json)</button>
                    </div>

                    <div class="backup-action-card">
                        <div>
                            <h3>📤 2. Завантажити копію назад у журнал</h3>
                            <p style="margin-top:8px;">Режим «Безпечне об’єднання» додає всі дані з файлу, <b>не видаляючи</b> нових записів у базі.</p>
                        </div>
                        <div style="display:flex; flex-direction:column; gap:8px;">
                            <label class="btn-blue" style="text-align:center; padding:11px; border-radius:6px; font-weight:bold; cursor:pointer; display:block;">
                                📤 Безпечно об’єднати з файлу (.json)
                                <input type="file" id="rep-bk-restore-merge" accept=".json" style="display:none;">
                            </label>
                            <label class="btn-slate" style="text-align:center; padding:8px; border-radius:6px; font-size:12px; font-weight:bold; cursor:pointer; display:block;">
                                🔄 Повна заміна бази з файлу (.json)
                                <input type="file" id="rep-bk-restore-overwrite" accept=".json" style="display:none;">
                            </label>
                        </div>
                    </div>
                </div>
            </div>
        `;

        container.appendChild(tabContent);
    }

    // --- ПЕРЕХВАТ ПЕРЕМИКАННЯ ВКЛАДОК ТА ПОВНОГО БЕКАПУ ---
    function hookExistingFunctions() {
        const origSwitchTab = window.switchTab;
        if (typeof origSwitchTab === 'function') {
            window.switchTab = function(tabId, btnEl) {
                origSwitchTab(tabId, btnEl);
                if (tabId === 'reporting') {
                    refreshAllReportingUI();
                }
            };
        }

        const isReportingVisible = () => {
            const el = document.getElementById('tab-reporting');
            return el && el.classList.contains('active');
        };

        const origUpdateDrop = window.updateSelectDropdowns;
        if (typeof origUpdateDrop === 'function') {
            window.updateSelectDropdowns = function() {
                origUpdateDrop.apply(this, arguments);
                if (isReportingVisible()) refreshAllReportingUI();
            };
        }

        const origRenderAtt = window.renderAttendanceAll;
        if (typeof origRenderAtt === 'function') {
            window.renderAttendanceAll = function() {
                origRenderAtt.apply(this, arguments);
                if (isReportingVisible() && (activeSubTab === 'attendance_reg' || activeSubTab === 'reports' || activeSubTab === 'backup')) {
                    refreshAllReportingUI();
                }
            };
        }

        // Розширюємо верхню кнопку повного бекапу, щоб вона також включала гілку звітності
        window.downloadFullBackup = function(includeLocalRequisites) {
            const inclLocal = !!includeLocalRequisites;
            Promise.all([
                db.ref('homework_reports').once('value'),
                db.ref('journal_classes').once('value'),
                db.ref('journal_students').once('value'),
                db.ref('journal_assignments').once('value'),
                db.ref('journal_games_catalog').once('value'),
                db.ref('deleted_reports').once('value'),
                db.ref('journal_attendance').once('value'),
                db.ref(REPORTING_DB_ROOT).once('value')
            ]).then(([repSnap, clsSnap, stuSnap, asgSnap, catSnap, delSnap, attSnap, modSnap]) => {
                const repVal = repSnap.val() || {};
                const attVal = attSnap.val() || {};
                const modVal = modSnap.val() || {};
                const stats = typeof countDatabaseStats === 'function' ? countDatabaseStats(repVal, attVal) : {};

                const backupPayload = {
                    backupVersion: '2.6-full',
                    backupCreatedAt: new Date().toISOString(),
                    statsSummary: Object.assign({}, stats, {
                        lessonsCount: Object.keys(modVal.lessons || {}).length,
                        cardsCount: Object.keys(modVal.progressCards || {}).length
                    }),
                    homework_reports: repVal,
                    journal_classes: clsSnap.val() || {},
                    journal_students: stuSnap.val() || {},
                    journal_assignments: asgSnap.val() || {},
                    journal_games_catalog: catSnap.val() || {},
                    deleted_reports: delSnap.val() || {},
                    journal_attendance: attVal,
                    journal_edu_reporting: modVal,
                    checked_reports_local: (typeof checkedReportsMap !== 'undefined' ? checkedReportsMap : {})
                };

                if (inclLocal) {
                    backupPayload.local_print_settings = getLocalSettings();
                }

                const blob = new Blob([JSON.stringify(backupPayload, null, 2)], { type: 'application/json;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const now = new Date();
                const datePart = todayYYYYMMDD();
                const timePart = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
                a.href = url;
                a.download = `zhurnal_povna_kopiya_${datePart}_${timePart}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            });
        };

        window.restoreFromBackupFile = function(event, mode = 'merge') {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const data = JSON.parse(e.target.result);
                    if (!data.homework_reports && !data.journal_students && !data.journal_attendance && !data.journal_edu_reporting) {
                        event.target.value = '';
                        return alert('Помилка: обраний файл не є коректною резервною копією журналу!');
                    }

                    const stats = typeof countDatabaseStats === 'function'
                        ? countDatabaseStats(data.homework_reports, data.journal_attendance)
                        : { reportsCount: 0, attCount: 0 };
                    const lessonsCnt = data.journal_edu_reporting ? Object.keys(data.journal_edu_reporting.lessons || {}).length : 0;
                    const cardsCnt = data.journal_edu_reporting ? Object.keys(data.journal_edu_reporting.progressCards || {}).length : 0;

                    const modeTitle = (mode === 'merge')
                        ? 'БЕЗПЕЧНЕ ОБ’ЄДНАННЯ (дані з файлу додадуться, новіші записи не зітруться)'
                        : 'ПОВНА ЗАМІНА БАЗИ (база повернеться точно до стану з файлу)';

                    if (!confirm(`Режим: ${modeTitle}\n\nЗнайдено у файлі:\n• Виконаних робіт ДЗ: ${stats.reportsCount}\n• Відміток відвідуваності: ${stats.attCount}\n• Занять у журналі обліку: ${lessonsCnt}\n• Карток прогресу: ${cardsCnt}\n\nПродовжити відновлення?`)) {
                        event.target.value = '';
                        return;
                    }

                    const updates = {};
                    const branches = [
                        'homework_reports', 'journal_classes', 'journal_students',
                        'journal_assignments', 'journal_games_catalog', 'deleted_reports',
                        'journal_attendance', REPORTING_DB_ROOT
                    ];

                    branches.forEach(branch => {
                        if (!data[branch]) return;
                        if (mode === 'overwrite') {
                            updates[branch] = data[branch];
                        } else if (typeof buildDeepMergeUpdates === 'function') {
                            buildDeepMergeUpdates(branch, data[branch], updates);
                        } else {
                            updates[branch] = data[branch];
                        }
                    });

                    if (data.checked_reports_local && typeof data.checked_reports_local === 'object' && typeof checkedReportsMap !== 'undefined') {
                        Object.assign(checkedReportsMap, data.checked_reports_local);
                        localStorage.setItem('journal_checked_reports_v1', JSON.stringify(checkedReportsMap));
                    }

                    if (data.local_print_settings && typeof data.local_print_settings === 'object') {
                        saveLocalSettingsObj(Object.assign(getLocalSettings(), data.local_print_settings));
                        populateLocalSettingsForm();
                    }

                    db.ref().update(updates).then(() => {
                        alert(`Дані успішно відновлено!\nРобіт ДЗ: ${stats.reportsCount} | Відвідуваність: ${stats.attCount} | Занять: ${lessonsCnt} | Карток: ${cardsCnt}`);
                        event.target.value = '';
                        if (typeof renderBackupLiveStats === 'function') renderBackupLiveStats();
                        if (typeof loadReports === 'function') loadReports();
                        if (typeof renderAttendanceAll === 'function') renderAttendanceAll();
                        refreshAllReportingUI();
                    });
                } catch (err) {
                    event.target.value = '';
                    alert('Не вдалося прочитати JSON-файл резервної копії!');
                }
            };
            reader.readAsText(file);
        };
    }

    // --- ХЕЛПЕРИ ДРУКУ ТА CSV ---
    function printHtmlA4(innerHtml) {
        const wrapper = document.getElementById('printable-a4-Wrapper');
        if (!wrapper) return alert('Не знайдено контейнер друку!');
        wrapper.innerHTML = `<div class="print-preview-card" style="font-size:13px; line-height:1.45;">${innerHtml}</div>`;
        setTimeout(() => window.print(), 100);
    }

    function downloadCSV(filename, rows) {
        const csvLines = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';'));
        const blob = new Blob(['\uFEFF' + csvLines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // --- 1. ЖУРНАЛ ПРОВЕДЕНИХ ЗАНЯТЬ ---
    function isBillableStatus(status) {
        return status === 'conducted' || status === 'paused' || status === 'noshow_paid';
    }

    function getStatusBadge(status) {
        if (status === 'conducted') return '<span class="rep-badge ok">✅ Проведено</span>';
        if (status === 'paused') return '<span class="rep-badge warn">⚠️ Безпекова пауза</span>';
        if (status === 'noshow_paid') return '<span class="rep-badge info">🕒 Неявка (оплач.)</span>';
        if (status === 'rescheduled') return '<span class="rep-badge warn">🔁 Перенесено</span>';
        return '<span class="rep-badge err">❌ Скасовано</span>';
    }

    function getStatusPlainText(lesson) {
        const parts = [];
        if (lesson.status === 'conducted') parts.push('Проведено за графіком');
        else if (lesson.status === 'paused') {
            const pInfo = (lesson.pauseStart || lesson.pauseEnd)
                ? `Призупинено з міркувань безпеки: ${lesson.pauseStart || '?'}–${lesson.pauseEnd || '?'}`
                : 'Призупинено та відновлено з міркувань безпеки';
            parts.push(pInfo);
        } else if (lesson.status === 'noshow_paid') {
            parts.push('Неявка слухачів без завчасного попередження (викладач готовий у погоджений час)');
        } else if (lesson.status === 'rescheduled') parts.push('Перенесено за погодженням');
        else if (lesson.status === 'cancelled') parts.push('Скасовано');
        if (lesson.notes) parts.push(lesson.notes);
        return parts.join('; ');
    }

    function getFilteredLessons(monthOverride) {
        const monthVal = monthOverride !== undefined ? monthOverride : document.getElementById('rep-l-filter-month').value;
        const grpVal = document.getElementById('rep-l-filter-group').value;
        const subjVal = document.getElementById('rep-l-filter-subject').value;

        return Object.entries(repData.lessons || {})
            .map(([id, item]) => Object.assign({ id }, item))
            .filter(l => {
                if (monthVal && !(l.date || '').startsWith(monthVal)) return false;
                if (monthOverride === undefined) {
                    if (grpVal && grpVal !== 'all' && l.group !== grpVal) return false;
                    if (subjVal && subjVal !== 'all' && l.subject !== subjVal) return false;
                }
                return true;
            })
            .sort((a, b) => ((a.date || '') + (a.startTime || '')).localeCompare((b.date || '') + (b.startTime || '')));
    }

    function renderLessonsSection() {
        const groups = getAvailableGroupOptions();
        const grpSelect = document.getElementById('rep-l-group');
        const grpFilter = document.getElementById('rep-l-filter-group');
        const ktpGrp = document.getElementById('rep-ktp-group');

        const curG = grpSelect.value;
        const curFG = grpFilter.value;
        const curKG = ktpGrp.value;

        grpSelect.innerHTML = groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
        grpFilter.innerHTML = `<option value="all">Усі групи</option>` + groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
        ktpGrp.innerHTML = groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');

        if (groups.includes(curG)) grpSelect.value = curG;
        if (curFG === 'all' || groups.includes(curFG)) grpFilter.value = curFG;
        if (groups.includes(curKG)) ktpGrp.value = curKG;

        const list = getFilteredLessons();
        let totalBillableHours = 0;
        let uaHours = 0;
        let mathHours = 0;
        let pausesCount = 0;

        list.forEach(l => {
            const hrs = (Number(l.durationMin) || 60) / 60;
            if (isBillableStatus(l.status)) {
                totalBillableHours += hrs;
                if (l.subject === 'Українська мова') uaHours += hrs;
                if (l.subject === 'Математика') mathHours += hrs;
            }
            if (l.status === 'paused') pausesCount++;
        });

        const settings = getLocalSettings();
        const rate = Number(settings.hourlyRate) || 0;
        const sumEst = Math.round(totalBillableHours * rate * 100) / 100;

        document.getElementById('rep-lessons-kpi').innerHTML = `
            <div class="rep-kpi"><div class="k-lbl">Зарахованих год. (фільтр)</div><div class="k-val" style="color:#10b981;">${totalBillableHours.toFixed(1)} год.</div></div>
            <div class="rep-kpi"><div class="k-lbl">Українська мова</div><div class="k-val" style="color:#38bdf8;">${uaHours.toFixed(1)} год.</div></div>
            <div class="rep-kpi"><div class="k-lbl">Математика</div><div class="k-val" style="color:#a78bfa;">${mathHours.toFixed(1)} год.</div></div>
            <div class="rep-kpi"><div class="k-lbl">Орієнтовна сума (${rate} грн/год)</div><div class="k-val" style="color:#fbbf24;">${sumEst.toLocaleString('uk-UA')} грн</div></div>
        `;

        const wrap = document.getElementById('rep-lessons-table-wrap');
        if (list.length === 0) {
            wrap.innerHTML = `<p style="text-align:center; color:#64748b; padding:18px;">За обраним фільтром занять ще немає. Додайте перше заняття вище.</p>`;
            return;
        }

        let html = `<table><thead><tr>
            <th>№</th><th>Дата і час</th><th>Тривалість</th><th>Предмет</th><th>Група</th><th>Тема та матеріал</th><th>Учнів</th><th>Статус / Примітки</th><th>Дії</th>
        </tr></thead><tbody>`;

        list.forEach((l, idx) => {
            const hrs = ((Number(l.durationMin) || 60) / 60).toFixed(1).replace('.0', '');
            const pauseTxt = (l.status === 'paused' && (l.pauseStart || l.pauseEnd))
                ? `<br><small style="color:#fbbf24;">Пауза: ${esc(l.pauseStart || '?')}–${esc(l.pauseEnd || '?')}</small>` : '';
            html += `<tr>
                <td>${idx + 1}</td>
                <td style="white-space:nowrap;"><b>${esc(formatDMY(l.date))}</b><br><small style="color:#94a3b8;">${esc(l.startTime || '')}–${esc(l.endTime || '')}</small></td>
                <td>${esc(l.durationMin || 60)} хв<br><small style="color:#94a3b8;">(${hrs} год.)</small></td>
                <td>${esc(l.subject)}</td>
                <td>${esc(l.group)}</td>
                <td>${esc(l.topic || '—')}</td>
                <td style="text-align:center; font-weight:bold;">${esc(l.attendees ?? 0)}</td>
                <td>${getStatusBadge(l.status)}${pauseTxt}${l.notes ? `<br><small style="color:#94a3b8;">${esc(l.notes)}</small>` : ''}</td>
                <td>
                    <div class="btn-group">
                        <button type="button" class="btn-edit" onclick="window.__repEditLesson('${escJs(l.id)}')">✏️</button>
                        <button type="button" class="btn-delete" onclick="window.__repDeleteLesson('${escJs(l.id)}')">🗑️</button>
                    </div>
                </td>
            </tr>`;
        });
        html += `</tbody></table>`;
        wrap.innerHTML = html;
    }

    function saveLesson() {
        const date = document.getElementById('rep-l-date').value;
        const startTime = document.getElementById('rep-l-start').value;
        const endTime = document.getElementById('rep-l-end').value;
        const durationMin = Number(document.getElementById('rep-l-dur').value) || 60;
        const subject = document.getElementById('rep-l-subject').value;
        const group = document.getElementById('rep-l-group').value;
        const attendees = Number(document.getElementById('rep-l-att').value) || 0;
        const status = document.getElementById('rep-l-status').value;
        const pauseStart = document.getElementById('rep-l-pstart').value;
        const pauseEnd = document.getElementById('rep-l-pend').value;
        const topic = document.getElementById('rep-l-topic').value.trim();
        const notes = document.getElementById('rep-l-notes').value.trim();

        if (!date) return alert('Вкажіть дату заняття!');
        if (!topic && status !== 'cancelled' && status !== 'rescheduled' && status !== 'noshow_paid') {
            return alert('Вкажіть тему заняття!');
        }

        const payload = {
            date, startTime, endTime, durationMin, subject, group, attendees,
            status, pauseStart, pauseEnd, topic, notes,
            addedAt: new Date().toISOString()
        };

        const ref = editingLessonId
            ? db.ref(`${REPORTING_DB_ROOT}/lessons/${editingLessonId}`).set(payload)
            : db.ref(`${REPORTING_DB_ROOT}/lessons`).push(payload);

        ref.then(() => {
            resetLessonForm();
        });
    }

    function resetLessonForm() {
        editingLessonId = null;
        document.getElementById('rep-lesson-form-title').innerText = '➕ Записати проведене заняття';
        document.getElementById('rep-lesson-cancel-edit').style.display = 'none';
        document.getElementById('rep-l-topic').value = '';
        document.getElementById('rep-l-notes').value = '';
        document.getElementById('rep-l-pstart').value = '';
        document.getElementById('rep-l-pend').value = '';
        document.getElementById('rep-l-status').value = 'conducted';
        document.getElementById('rep-l-pause-box').style.display = 'none';
    }

    window.__repEditLesson = function(id) {
        const l = (repData.lessons || {})[id];
        if (!l) return;
        editingLessonId = id;
        document.getElementById('rep-lesson-form-title').innerText = '✏️ Редагування запису заняття';
        document.getElementById('rep-lesson-cancel-edit').style.display = 'inline-block';
        document.getElementById('rep-l-date').value = l.date || '';
        document.getElementById('rep-l-start').value = l.startTime || '15:00';
        document.getElementById('rep-l-end').value = l.endTime || '16:00';
        document.getElementById('rep-l-dur').value = l.durationMin || 60;
        document.getElementById('rep-l-subject').value = l.subject || 'Українська мова';
        document.getElementById('rep-l-group').value = l.group || DEFAULT_GROUPS[0];
        document.getElementById('rep-l-att').value = l.attendees ?? 0;
        document.getElementById('rep-l-status').value = l.status || 'conducted';
        document.getElementById('rep-l-pstart').value = l.pauseStart || '';
        document.getElementById('rep-l-pend').value = l.pauseEnd || '';
        document.getElementById('rep-l-topic').value = l.topic || '';
        document.getElementById('rep-l-notes').value = l.notes || '';
        document.getElementById('rep-l-pause-box').style.display = l.status === 'paused' ? 'grid' : 'none';
        document.getElementById('rep-l-date').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    window.__repDeleteLesson = function(id) {
        if (confirm('Видалити цей запис із журналу занять?')) {
            db.ref(`${REPORTING_DB_ROOT}/lessons/${id}`).remove();
        }
    };

    function syncAttendeesFromTab() {
        const dateVal = document.getElementById('rep-l-date').value;
        const grpLabel = document.getElementById('rep-l-group').value;
        if (!dateVal) return alert('Спочатку оберіть дату!');
        const month = dateVal.slice(0, 7);
        const dayObj = (typeof attendanceData !== 'undefined' && attendanceData[month] && attendanceData[month][dateVal]) ? attendanceData[month][dateVal] : null;
        if (!dayObj) return alert(`За дату ${formatDMY(dateVal)} у вкладці «Відвідуваність» ще немає відміток.`);

        // Шукаємо клас за назвою
        let matchedCatId = null;
        if (typeof classesData !== 'undefined') {
            for (const cid in classesData) {
                if (classesData[cid].name === grpLabel) { matchedCatId = cid; break; }
            }
        }
        let presentCount = 0;
        if (matchedCatId && dayObj[matchedCatId]) {
            Object.values(dayObj[matchedCatId]).forEach(st => { if (st === 'present') presentCount++; });
        } else {
            // Якщо назва групи не збігається 1-в-1, рахуємо по всіх класах за цей день
            for (const cid in dayObj) {
                if (cid === 'individual') continue;
                Object.values(dayObj[cid]).forEach(st => { if (st === 'present') presentCount++; });
            }
        }
        document.getElementById('rep-l-att').value = presentCount;
    }

    function printLessonsJournal() {
        const list = getFilteredLessons();
        const settings = getLocalSettings();
        const monthVal = document.getElementById('rep-l-filter-month').value;
        const periodStr = monthVal ? `за ${monthVal}` : (settings.periodLabel || 'за весь період');

        let totals = {};
        let grandHrs = 0;
        const rowsHtml = list.map((l, idx) => {
            const hrs = (Number(l.durationMin) || 60) / 60;
            if (isBillableStatus(l.status)) {
                grandHrs += hrs;
                const key = `${l.subject} — ${l.group}`;
                totals[key] = (totals[key] || 0) + hrs;
            }
            return `<tr>
                <td style="text-align:center;">${idx + 1}</td>
                <td>${esc(formatDMY(l.date))}<br>${esc(l.startTime || '')}–${esc(l.endTime || '')}</td>
                <td style="text-align:center;">${esc(l.durationMin || 60)} хв (${hrs.toFixed(1).replace('.0', '')} год.)</td>
                <td>${esc(l.subject)}</td>
                <td>${esc(l.group)}</td>
                <td>${esc(l.topic || '—')}</td>
                <td style="text-align:center;">${esc(l.attendees ?? 0)}</td>
                <td>${esc(getStatusPlainText(l))}</td>
            </tr>`;
        }).join('');

        const summaryLines = Object.entries(totals).map(([k, v]) => `<li><b>${esc(k)}:</b> ${v.toFixed(1).replace('.0', '')} навч. год.</li>`).join('');

        const html = `
            <div style="text-align:center; border-bottom:2px solid #0f172a; padding-bottom:10px; margin-bottom:14px;">
                <h2 style="margin:0; font-size:19px;">ЖУРНАЛ ОБЛІКУ ПРОВЕДЕНИХ ЗАНЯТЬ</h2>
                <div style="font-size:13px; color:#334155; margin-top:4px;">${esc(periodStr)}${settings.docBasis ? ` | ${esc(settings.docBasis)}` : ''}</div>
            </div>
            ${settings.executorTitle || settings.clientTitle ? `
            <div style="margin-bottom:12px; font-size:13px;">
                ${settings.executorTitle ? `<div><b>Виконавець:</b> ${esc(settings.executorTitle)}</div>` : ''}
                ${settings.clientTitle ? `<div><b>Замовник:</b> ${esc(settings.clientTitle)}</div>` : ''}
            </div>` : ''}
            <table>
                <thead><tr>
                    <th>№</th><th>Дата і час</th><th>Тривалість</th><th>Предмет</th><th>Група</th><th>Тема та короткий опис матеріалу</th><th>Учнів</th><th>Примітки / Паузи / Перенесення</th>
                </tr></thead>
                <tbody>${rowsHtml || '<tr><td colspan="8" style="text-align:center;">Записів немає</td></tr>'}</tbody>
            </table>
            <div style="margin-top:14px;">
                <b>Підсумок зарахованих навчальних годин:</b>
                <ul style="margin:6px 0 8px 18px;">${summaryLines || '<li>0 год.</li>'}</ul>
                <div><b>Всього зараховано:</b> ${grandHrs.toFixed(1).replace('.0', '')} навч. год.</div>
            </div>
            <div style="margin-top:26px; display:flex; justify-content:space-between;">
                <div>Виконавець: _______________________ ${esc(settings.executorSigner || '')}</div>
                <div>Дата: ${new Date().toLocaleDateString('uk-UA')}</div>
            </div>
        `;
        printHtmlA4(html);
    }

    function exportLessonsCSV() {
        const list = getFilteredLessons();
        const rows = [['№', 'Дата', 'Початок', 'Кінець', 'Тривалість (хв)', 'Годин', 'Предмет', 'Група', 'Тема та опис', 'Присутніх', 'Статус та примітки']];
        list.forEach((l, i) => {
            rows.push([
                i + 1, l.date, l.startTime || '', l.endTime || '', l.durationMin || 60,
                ((Number(l.durationMin) || 60) / 60).toFixed(1),
                l.subject, l.group, l.topic || '', l.attendees ?? 0, getStatusPlainText(l)
            ]);
        });
        downloadCSV(`zhurnal_zanyat_${todayYYYYMMDD()}.csv`, rows);
    }

    // --- 2. РЕЄСТР ВІДВІДУВАНОСТІ (ЗНЕОСОБЛЕНИЙ З КОДАМИ) ---
    function findStudentMetaEntry(categoryId, studentName) {
        for (const id in (repData.studentMeta || {})) {
            const m = repData.studentMeta[id];
            if (m && m.categoryId === categoryId && m.studentName === studentName) {
                return Object.assign({ id }, m);
            }
        }
        return null;
    }

    function renderAttendanceRegisterSection() {
        const clsSel = document.getElementById('rep-ar-class');
        const curCls = clsSel.value;
        const classIds = typeof classesData !== 'undefined'
            ? Object.keys(classesData).sort((a, b) => (classesData[a].name || '').localeCompare(classesData[b].name || ''))
            : [];

        clsSel.innerHTML = classIds.length > 0
            ? classIds.map(cid => `<option value="${esc(cid)}">👥 ${esc(classesData[cid].name)}</option>`).join('')
            : '<option value="">Немає створених класів</option>';
        if (classIds.includes(curCls)) clsSel.value = curCls;

        const selectedCid = clsSel.value;
        const monthVal = document.getElementById('rep-ar-month').value || todayYYYYMMDD().slice(0, 7);
        const isAnon = document.getElementById('rep-ar-anon').checked;
        const codesEditor = document.getElementById('rep-ar-codes-editor');
        const tableWrap = document.getElementById('rep-ar-table-wrap');

        if (!selectedCid || typeof studentsData === 'undefined' || !studentsData[selectedCid]) {
            codesEditor.innerHTML = '<p style="color:#64748b; font-size:13px;">Оберіть клас з учнями (класи створюються у вкладці «Учні та Класи»).</p>';
            tableWrap.innerHTML = '<p style="text-align:center; color:#64748b; padding:18px;">Немає учнів у вибраному класі.</p>';
            return;
        }

        const students = Object.values(studentsData[selectedCid]).sort((a, b) => a.localeCompare(b));

        // Редактор кодів
        let edHtml = `<table><thead><tr><th>Учень (видно лише вам)</th><th>Анонімний код</th><th>Клас (1–4)</th><th>Коротка примітка про пропуски (без чутливих даних)</th><th>Дія</th></tr></thead><tbody>`;
        students.forEach((sName, idx) => {
            const meta = findStudentMetaEntry(selectedCid, sName);
            const codeVal = meta ? (meta.code || '') : '';
            const gradeVal = meta ? (meta.grade || '') : '';
            const noteVal = meta ? (meta.absenceNote || '') : '';
            const rowKey = `ar_meta_${idx}`;
            edHtml += `<tr>
                <td style="font-weight:bold;">${esc(sName)}</td>
                <td><input type="text" id="${rowKey}_code" value="${esc(codeVal)}" placeholder="Напр. G1-0${idx + 1}" style="width:110px;"></td>
                <td><input type="text" id="${rowKey}_grade" value="${esc(gradeVal)}" placeholder="1 / 2 / 3 / 4" style="width:75px;"></td>
                <td><input type="text" id="${rowKey}_note" value="${esc(noteVal)}" placeholder="Напр.: технічні причини" style="width:100%; min-width:160px;"></td>
                <td><button type="button" class="btn-blue" style="padding:6px 10px; font-size:12px;" onclick="window.__repSaveStuMeta('${escJs(selectedCid)}', '${escJs(sName)}', '${rowKey}')">💾</button></td>
            </tr>`;
        });
        edHtml += `</tbody></table>`;
        codesEditor.innerHTML = edHtml;

        // Збираємо дні з відмітками за місяць
        const monthAtt = (typeof attendanceData !== 'undefined' && attendanceData[monthVal]) ? attendanceData[monthVal] : {};
        const activeDays = Object.keys(monthAtt)
            .filter(d => monthAtt[d] && monthAtt[d][selectedCid] && Object.keys(monthAtt[d][selectedCid]).length > 0)
            .sort();

        if (activeDays.length === 0) {
            tableWrap.innerHTML = `<p style="text-align:center; color:#94a3b8; padding:18px;">За ${esc(monthVal)} у вкладці «📅 Відвідуваність» для цього класу ще немає відміток.</p>`;
            return;
        }

        const tableHtml = buildAttendanceRegisterTableHtml(selectedCid, students, activeDays, monthAtt, isAnon, false);
        tableWrap.innerHTML = tableHtml;
    }

    function buildAttendanceRegisterTableHtml(selectedCid, students, activeDays, monthAtt, isAnon, forPrint) {
        let html = `<table><thead><tr>
            <th>№</th>
            <th>${isAnon ? 'Код учня' : 'Учень (Код)'}</th>
            <th>Клас</th>
            ${activeDays.map(d => `<th style="text-align:center;">${d.slice(8, 10)}.${d.slice(5, 7)}</th>`).join('')}
            <th style="text-align:center;">Відвідано</th>
            <th style="text-align:center;">%</th>
            <th>Примітка</th>
        </tr></thead><tbody>`;

        const dayPresentTotals = {};
        activeDays.forEach(d => dayPresentTotals[d] = 0);
        let sumPresent = 0, sumCounted = 0;

        students.forEach((sName, idx) => {
            const meta = findStudentMetaEntry(selectedCid, sName);
            const code = (meta && meta.code) ? meta.code : `U-${String(idx + 1).padStart(2, '0')}`;
            const label = isAnon ? code : `${sName} (${code})`;
            const grade = (meta && meta.grade) ? meta.grade : '—';
            const note = (meta && meta.absenceNote) ? meta.absenceNote : '—';

            let pres = 0, counted = 0;
            const cells = activeDays.map(d => {
                const st = monthAtt[d] && monthAtt[d][selectedCid] ? monthAtt[d][selectedCid][sName] : null;
                let txt = '—';
                let color = forPrint ? '#64748b' : '#475569';
                if (st === 'present') {
                    txt = 'П'; pres++; counted++; dayPresentTotals[d]++;
                    color = forPrint ? '#059669' : '#10b981';
                } else if (st === 'absent') {
                    txt = 'Н'; counted++;
                    color = forPrint ? '#dc2626' : '#ef4444';
                } else if (st === 'excused') {
                    txt = 'Н(п)';
                    color = forPrint ? '#d97706' : '#f59e0b';
                }
                return `<td style="text-align:center; font-weight:bold; color:${color};">${txt}</td>`;
            }).join('');

            sumPresent += pres;
            sumCounted += counted;
            const pct = counted > 0 ? `${Math.round((pres / counted) * 100)}%` : '—';

            html += `<tr>
                <td style="text-align:center;">${idx + 1}</td>
                <td style="font-weight:bold;">${esc(label)}</td>
                <td style="text-align:center;">${esc(grade)}</td>
                ${cells}
                <td style="text-align:center;">${pres} з ${activeDays.length}</td>
                <td style="text-align:center; font-weight:bold;">${pct}</td>
                <td>${esc(note)}</td>
            </tr>`;
        });

        const avgAll = sumCounted > 0 ? `${Math.round((sumPresent / sumCounted) * 100)}%` : '—';
        html += `<tr style="font-weight:bold;">
            <td colspan="3">Разом присутніх:</td>
            ${activeDays.map(d => `<td style="text-align:center;">${dayPresentTotals[d]}</td>`).join('')}
            <td style="text-align:center;">Середня:</td>
            <td style="text-align:center;">${avgAll}</td>
            <td>—</td>
        </tr>`;
        html += `</tbody></table>`;
        return html;
    }

    window.__repSaveStuMeta = function(categoryId, studentName, rowKey) {
        const code = document.getElementById(`${rowKey}_code`).value.trim();
        const grade = document.getElementById(`${rowKey}_grade`).value.trim();
        const absenceNote = document.getElementById(`${rowKey}_note`).value.trim();
        const existing = findStudentMetaEntry(categoryId, studentName);
        const clsName = (typeof classesData !== 'undefined' && classesData[categoryId]) ? classesData[categoryId].name : '';

        const payload = {
            categoryId, studentName, code, grade, absenceNote,
            groupLabel: clsName,
            addedAt: new Date().toISOString()
        };
        const ref = existing
            ? db.ref(`${REPORTING_DB_ROOT}/studentMeta/${existing.id}`).set(payload)
            : db.ref(`${REPORTING_DB_ROOT}/studentMeta`).push(payload);
        ref.then(() => renderAttendanceRegisterSection());
    };

    function autoAssignClassCodes() {
        const selectedCid = document.getElementById('rep-ar-class').value;
        if (!selectedCid || !studentsData[selectedCid]) return alert('Оберіть клас з учнями!');
        const prefix = prompt('Введіть префікс коду для цієї групи (наприклад, G1 або G2):', 'G1');
        if (!prefix) return;
        const students = Object.values(studentsData[selectedCid]).sort((a, b) => a.localeCompare(b));
        const clsName = (classesData[selectedCid] && classesData[selectedCid].name) ? classesData[selectedCid].name : '';
        const updates = {};
        students.forEach((sName, idx) => {
            const existing = findStudentMetaEntry(selectedCid, sName);
            const id = existing ? existing.id : db.ref(`${REPORTING_DB_ROOT}/studentMeta`).push().key;
            updates[`${REPORTING_DB_ROOT}/studentMeta/${id}`] = {
                categoryId: selectedCid,
                studentName: sName,
                code: (existing && existing.code) ? existing.code : `${prefix.trim()}-${String(idx + 1).padStart(2, '0')}`,
                grade: (existing && existing.grade) ? existing.grade : '',
                absenceNote: (existing && existing.absenceNote) ? existing.absenceNote : '',
                groupLabel: clsName,
                addedAt: new Date().toISOString()
            };
        });
        db.ref().update(updates).then(() => alert('Коди учнів присвоєно!'));
    }

    function printAttendanceRegister() {
        const selectedCid = document.getElementById('rep-ar-class').value;
        const monthVal = document.getElementById('rep-ar-month').value || todayYYYYMMDD().slice(0, 7);
        const subj = document.getElementById('rep-ar-subject').value;
        const isAnon = document.getElementById('rep-ar-anon').checked;
        if (!selectedCid || !studentsData[selectedCid]) return alert('Немає даних для друку!');
        const clsName = classesData[selectedCid] ? classesData[selectedCid].name : '';
        const students = Object.values(studentsData[selectedCid]).sort((a, b) => a.localeCompare(b));
        const monthAtt = (attendanceData[monthVal]) ? attendanceData[monthVal] : {};
        const activeDays = Object.keys(monthAtt)
            .filter(d => monthAtt[d] && monthAtt[d][selectedCid] && Object.keys(monthAtt[d][selectedCid]).length > 0)
            .sort();
        if (activeDays.length === 0) return alert('Немає відміток за обраний місяць!');

        const settings = getLocalSettings();
        const tableHtml = buildAttendanceRegisterTableHtml(selectedCid, students, activeDays, monthAtt, isAnon, true);
        const html = `
            <div style="text-align:center; border-bottom:2px solid #0f172a; padding-bottom:10px; margin-bottom:14px;">
                <h2 style="margin:0; font-size:19px;">РЕЄСТР ВІДВІДУВАНОСТІ УЧНІВ</h2>
                <div style="font-size:13px; color:#334155; margin-top:4px;">Період: ${esc(monthVal)} | Група: ${esc(clsName)} | Предмет: ${esc(subj)}${settings.docBasis ? ` | ${esc(settings.docBasis)}` : ''}</div>
            </div>
            <div style="font-size:12px; color:#475569; margin-bottom:10px;">
                Умовні позначення: <b>П</b> — присутній(я); <b>Н</b> — відсутній(я); <b>Н(п)</b> — відсутній(я) з поважної причини.
            </div>
            ${tableHtml}
            <div style="margin-top:26px; display:flex; justify-content:space-between;">
                <div>Виконавець: _______________________ ${esc(settings.executorSigner || '')}</div>
                <div>Дата: ${new Date().toLocaleDateString('uk-UA')}</div>
            </div>
        `;
        printHtmlA4(html);
    }

    function exportAttendanceRegisterCSV() {
        const selectedCid = document.getElementById('rep-ar-class').value;
        const monthVal = document.getElementById('rep-ar-month').value || todayYYYYMMDD().slice(0, 7);
        const isAnon = document.getElementById('rep-ar-anon').checked;
        if (!selectedCid || !studentsData[selectedCid]) return alert('Немає даних!');
        const students = Object.values(studentsData[selectedCid]).sort((a, b) => a.localeCompare(b));
        const monthAtt = attendanceData[monthVal] || {};
        const activeDays = Object.keys(monthAtt)
            .filter(d => monthAtt[d] && monthAtt[d][selectedCid] && Object.keys(monthAtt[d][selectedCid]).length > 0)
            .sort();
        if (activeDays.length === 0) return alert('Немає відміток за цей місяць!');

        const rows = [[isAnon ? 'Код учня' : 'Учень (Код)', 'Клас', ...activeDays.map(d => `${d.slice(8, 10)}.${d.slice(5, 7)}`), 'Відвідано', '%', 'Примітка']];
        students.forEach((sName, idx) => {
            const meta = findStudentMetaEntry(selectedCid, sName);
            const code = (meta && meta.code) ? meta.code : `U-${String(idx + 1).padStart(2, '0')}`;
            let pres = 0, counted = 0;
            const r = [isAnon ? code : `${sName} (${code})`, (meta && meta.grade) || ''];
            activeDays.forEach(d => {
                const st = monthAtt[d][selectedCid][sName];
                if (st === 'present') { pres++; counted++; r.push('П'); }
                else if (st === 'absent') { counted++; r.push('Н'); }
                else if (st === 'excused') { r.push('Н(п)'); }
                else r.push('');
            });
            r.push(`${pres} з ${activeDays.length}`, counted > 0 ? `${Math.round((pres / counted) * 100)}%` : '—', (meta && meta.absenceNote) || '');
            rows.push(r);
        });
        downloadCSV(`reestr_vidviduvanosti_${monthVal}.csv`, rows);
    }

    // --- 3. ІНДИВІДУАЛЬНІ КАРТКИ НАВЧАЛЬНОГО ПРОГРЕСУ ---
    function computeCardSubjectAvg(scoresObj, comps, stage) {
        if (!scoresObj) return null;
        const vals = [];
        comps.forEach(c => {
            const n = parseNum(scoresObj[c.key] ? scoresObj[c.key][stage] : null);
            if (n !== null) vals.push(n);
        });
        if (vals.length === 0) return null;
        return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    }

    function renderProgressCardsSection() {
        const sel = document.getElementById('rep-pc-select');
        const cards = Object.entries(repData.progressCards || {})
            .map(([id, c]) => Object.assign({ id }, c))
            .sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }));

        if (cards.length === 0) {
            sel.innerHTML = '<option value="">Немає створених карток</option>';
            currentCardId = null;
            document.getElementById('rep-pc-editor-wrap').innerHTML = `
                <p style="text-align:center; color:#94a3b8; padding:20px;">
                    Натисніть <b>«➕ Нова картка»</b> або <b>«⚡ Створити картки для класу»</b>, щоб почати фіксувати первинне, проміжне та підсумкове оцінювання.
                </p>`;
            return;
        }

        if (!currentCardId || !repData.progressCards[currentCardId]) {
            currentCardId = cards[0].id;
        }

        sel.innerHTML = cards.map(c => {
            const hint = c.linkedStudent ? ` (${c.linkedStudent} — лише для вас)` : '';
            return `<option value="${esc(c.id)}" ${c.id === currentCardId ? 'selected' : ''}>${esc(c.code || 'Без коду')} | ${esc(c.groupLabel || 'Група')}${esc(hint)}</option>`;
        }).join('');

        renderSingleProgressCardEditor(currentCardId);
    }

    function renderSingleProgressCardEditor(cardId) {
        const c = (repData.progressCards || {})[cardId];
        const wrap = document.getElementById('rep-pc-editor-wrap');
        if (!c) { wrap.innerHTML = ''; return; }

        const groups = getAvailableGroupOptions();
        const uaScores = c.uaScores || {};
        const mathScores = c.mathScores || {};

        function buildCompRows(prefix, comps, scoresObj) {
            let rows = '';
            comps.forEach(comp => {
                const s = scoresObj[comp.key] || {};
                const v1 = parseNum(s.init);
                const v3 = parseNum(s.final);
                const v2 = parseNum(s.mid);
                const latest = v3 !== null ? v3 : v2;
                let dyn = '—';
                if (v1 !== null && latest !== null) {
                    const diff = Math.round((latest - v1) * 10) / 10;
                    dyn = diff > 0 ? `<span style="color:#10b981; font-weight:bold;">+${diff}</span>` : (diff < 0 ? `<span style="color:#ef4444;">${diff}</span>` : '0');
                }
                rows += `<tr>
                    <td>${esc(comp.label)}</td>
                    <td style="text-align:center;"><input type="text" id="pc_${prefix}_${comp.key}_init" value="${esc(s.init ?? '')}" placeholder="0–100"></td>
                    <td style="text-align:center;"><input type="text" id="pc_${prefix}_${comp.key}_mid" value="${esc(s.mid ?? '')}" placeholder="0–100"></td>
                    <td style="text-align:center;"><input type="text" id="pc_${prefix}_${comp.key}_final" value="${esc(s.final ?? '')}" placeholder="0–100"></td>
                    <td style="text-align:center;">${dyn}</td>
                </tr>`;
            });
            const a1 = computeCardSubjectAvg(scoresObj, comps, 'init');
            const a2 = computeCardSubjectAvg(scoresObj, comps, 'mid');
            const a3 = computeCardSubjectAvg(scoresObj, comps, 'final');
            const lastAvg = a3 !== null ? a3 : a2;
            const avgDiff = (a1 !== null && lastAvg !== null) ? Math.round((lastAvg - a1) * 10) / 10 : null;
            rows += `<tr style="background:#0f172a; font-weight:bold;">
                <td>Середній показник</td>
                <td style="text-align:center; color:#38bdf8;">${a1 !== null ? a1 : '—'}</td>
                <td style="text-align:center; color:#38bdf8;">${a2 !== null ? a2 : '—'}</td>
                <td style="text-align:center; color:#38bdf8;">${a3 !== null ? a3 : '—'}</td>
                <td style="text-align:center; color:${avgDiff > 0 ? '#10b981' : '#94a3b8'};">${avgDiff !== null ? (avgDiff > 0 ? '+' + avgDiff : avgDiff) : '—'}</td>
            </tr>`;
            return rows;
        }

        wrap.innerHTML = `
            <div class="rep-form-grid">
                <div class="rep-field">
                    <label>Код / ідентифікатор учня (для звіту)</label>
                    <input type="text" id="pc-code" value="${esc(c.code || '')}" placeholder="Напр. G1-01">
                </div>
                <div class="rep-field">
                    <label>Клас</label>
                    <input type="text" id="pc-grade" value="${esc(c.grade || '')}" placeholder="1 / 2 / 3 / 4">
                </div>
                <div class="rep-field">
                    <label>Навчальна група</label>
                    <select id="pc-group">${groups.map(g => `<option value="${esc(g)}" ${g === c.groupLabel ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
                </div>
                <div class="rep-field">
                    <label>Прив’язка до імені (НЕ друкується!)</label>
                    <input type="text" id="pc-linked-stu" list="all-students-datalist" value="${esc(c.linkedStudent || '')}" placeholder="Для підказки вчителю">
                </div>
                <div class="rep-field">
                    <label>Період навчання</label>
                    <input type="text" id="pc-period" value="${esc(c.period || getLocalSettings().periodLabel || '')}" placeholder="Листопад — грудень 2026">
                </div>
                <div class="rep-field">
                    <label>Мовна підтримка на старті</label>
                    <select id="pc-lang">
                        <option value="Достатній рівень володіння мовою навчання" ${c.langLevel === 'Достатній рівень володіння мовою навчання' ? 'selected' : ''}>Достатній рівень</option>
                        <option value="Потребує додаткової мовної підтримки" ${c.langLevel === 'Потребує додаткової мовної підтримки' ? 'selected' : ''}>Потребує мовної підтримки</option>
                    </select>
                </div>
                <div class="rep-field">
                    <label>Фактична відвідуваність (текст)</label>
                    <div style="display:flex; gap:6px;">
                        <input type="text" id="pc-att" value="${esc(c.attText || '')}" placeholder="Напр.: 14 із 16 занять (88%)">
                        <button type="button" class="btn-slate" style="padding:6px 9px; font-size:12px;" onclick="window.__repSyncCardAtt()" title="Підрахувати з вкладки Відвідуваність">🔄</button>
                    </div>
                </div>
                <div class="rep-field" style="justify-content:center;">
                    <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-top:16px; color:#cbd5e1;">
                        <input type="checkbox" id="pc-finished" ${c.finished ? 'checked' : ''} style="width:auto;">
                        Завершив(ла) курс (пройшов підсумкове)
                    </label>
                </div>
            </div>

            <h4 style="color:#38bdf8; margin:14px 0 6px 0;">1. Українська мова (оцінки у балах або % від 0 до 100)</h4>
            <div class="rep-field" style="margin-bottom:8px;">
                <label>Основні виявлені освітні прогалини (первинне оцінювання)</label>
                <input type="text" id="pc-ua-gaps" value="${esc(c.uaGaps || '')}" placeholder="Читання, письмо, словниковий запас...">
            </div>
            <div class="rep-table-scroll">
                <table class="rep-comp-table">
                    <thead><tr><th>Компетентність</th><th style="text-align:center;">Первинне</th><th style="text-align:center;">Проміжне</th><th style="text-align:center;">Підсумкове</th><th style="text-align:center;">Динаміка</th></tr></thead>
                    <tbody>${buildCompRows('ua', UA_COMPETENCIES, uaScores)}</tbody>
                </table>
            </div>

            <h4 style="color:#a78bfa; margin:18px 0 6px 0;">2. Математика (оцінки у балах або % від 0 до 100)</h4>
            <div class="rep-field" style="margin-bottom:8px;">
                <label>Основні виявлені освітні прогалини (первинне оцінювання)</label>
                <input type="text" id="pc-math-gaps" value="${esc(c.mathGaps || '')}" placeholder="Усний рахунок, текстові задачі...">
            </div>
            <div class="rep-table-scroll">
                <table class="rep-comp-table">
                    <thead><tr><th>Компетентність</th><th style="text-align:center;">Первинне</th><th style="text-align:center;">Проміжне</th><th style="text-align:center;">Підсумкове</th><th style="text-align:center;">Динаміка</th></tr></thead>
                    <tbody>${buildCompRows('math', MATH_COMPETENCIES, mathScores)}</tbody>
                </table>
            </div>

            <div class="rep-form-grid" style="margin-top:14px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));">
                <div class="rep-field">
                    <label>Досягнуті навчальні цілі (повністю / частково)</label>
                    <textarea id="pc-goals">${esc(c.achievedGoals || '')}</textarea>
                </div>
                <div class="rep-field">
                    <label>Теми, які залишаються складними</label>
                    <textarea id="pc-hard">${esc(c.hardTopics || '')}</textarea>
                </div>
                <div class="rep-field">
                    <label>Рекомендації щодо подальшого навчання</label>
                    <textarea id="pc-rec">${esc(c.recommendations || '')}</textarea>
                </div>
            </div>

            <div class="rep-actions-bar" style="margin-top:14px;">
                <button type="button" class="btn-blue" onclick="window.__repSaveCurrentCard()">💾 Зберегти картку прогресу</button>
                <button type="button" class="btn-delete" onclick="window.__repDeleteCurrentCard()">🗑️ Видалити картку</button>
            </div>
        `;
    }

    window.__repSyncCardAtt = function() {
        const sName = document.getElementById('pc-linked-stu').value.trim();
        if (!sName) return alert('Вкажіть прив’язку до імені учня (у полі вище), щоб порахувати його відвідуваність.');
        let pres = 0, total = 0;
        for (const m in (attendanceData || {})) {
            for (const d in attendanceData[m]) {
                for (const cid in attendanceData[m][d]) {
                    const st = attendanceData[m][d][cid][sName];
                    if (st === 'present') { pres++; total++; }
                    else if (st === 'absent') { total++; }
                }
            }
        }
        if (total === 0) return alert('У вкладці «Відвідуваність» ще немає відміток для цього учня.');
        document.getElementById('pc-att').value = `${pres} із ${total} занять (${Math.round((pres / total) * 100)}%)`;
    };

    window.__repSaveCurrentCard = function() {
        if (!currentCardId) return;
        const uaScores = {};
        UA_COMPETENCIES.forEach(c => {
            uaScores[c.key] = {
                init: document.getElementById(`pc_ua_${c.key}_init`).value.trim(),
                mid: document.getElementById(`pc_ua_${c.key}_mid`).value.trim(),
                final: document.getElementById(`pc_ua_${c.key}_final`).value.trim()
            };
        });
        const mathScores = {};
        MATH_COMPETENCIES.forEach(c => {
            mathScores[c.key] = {
                init: document.getElementById(`pc_math_${c.key}_init`).value.trim(),
                mid: document.getElementById(`pc_math_${c.key}_mid`).value.trim(),
                final: document.getElementById(`pc_math_${c.key}_final`).value.trim()
            };
        });

        const payload = {
            code: document.getElementById('pc-code').value.trim() || 'Без коду',
            grade: document.getElementById('pc-grade').value.trim(),
            groupLabel: document.getElementById('pc-group').value,
            linkedStudent: document.getElementById('pc-linked-stu').value.trim(),
            period: document.getElementById('pc-period').value.trim(),
            langLevel: document.getElementById('pc-lang').value,
            attText: document.getElementById('pc-att').value.trim(),
            finished: document.getElementById('pc-finished').checked,
            uaGaps: document.getElementById('pc-ua-gaps').value.trim(),
            mathGaps: document.getElementById('pc-math-gaps').value.trim(),
            uaScores, mathScores,
            achievedGoals: document.getElementById('pc-goals').value.trim(),
            hardTopics: document.getElementById('pc-hard').value.trim(),
            recommendations: document.getElementById('pc-rec').value.trim(),
            addedAt: new Date().toISOString()
        };

        db.ref(`${REPORTING_DB_ROOT}/progressCards/${currentCardId}`).set(payload).then(() => {
            alert(`Картку ${payload.code} збережено!`);
        });
    };

    window.__repDeleteCurrentCard = function() {
        if (!currentCardId) return;
        if (confirm('Видалити цю індивідуальну картку прогресу?')) {
            const delId = currentCardId;
            currentCardId = null;
            db.ref(`${REPORTING_DB_ROOT}/progressCards/${delId}`).remove();
        }
    };

    function createNewProgressCard() {
        const code = prompt('Введіть анонімний код учня (наприклад, G1-01):', 'G1-01');
        if (!code) return;
        const newRef = db.ref(`${REPORTING_DB_ROOT}/progressCards`).push();
        currentCardId = newRef.key;
        newRef.set({
            code: code.trim(),
            grade: '',
            groupLabel: getAvailableGroupOptions()[0] || DEFAULT_GROUPS[0],
            linkedStudent: '',
            period: getLocalSettings().periodLabel || '',
            langLevel: 'Достатній рівень володіння мовою навчання',
            attText: '',
            finished: false,
            uaGaps: '', mathGaps: '', uaScores: {}, mathScores: {},
            achievedGoals: '', hardTopics: '', recommendations: '',
            addedAt: new Date().toISOString()
        });
    }

    function createCardsForClass() {
        const classIds = Object.keys(classesData || {});
        if (classIds.length === 0) return alert('Спочатку створіть клас і додайте учнів у вкладці «Учні та Класи».');
        const listStr = classIds.map((cid, i) => `${i + 1}. ${classesData[cid].name}`).join('\n');
        const pick = prompt(`Оберіть номер класу для автоматичного створення карток:\n${listStr}`, '1');
        if (!pick) return;
        const cid = classIds[parseInt(pick, 10) - 1];
        if (!cid || !studentsData[cid]) return alert('Невірний вибір або в класі немає учнів.');

        const clsName = classesData[cid].name;
        const students = Object.values(studentsData[cid]).sort((a, b) => a.localeCompare(b));
        const existingLinked = new Set(Object.values(repData.progressCards || {}).map(c => c.linkedStudent).filter(Boolean));
        const updates = {};
        let created = 0;

        students.forEach((sName, idx) => {
            if (existingLinked.has(sName)) return;
            const meta = findStudentMetaEntry(cid, sName);
            const code = (meta && meta.code) ? meta.code : `G-${String(idx + 1).padStart(2, '0')}`;
            const key = db.ref(`${REPORTING_DB_ROOT}/progressCards`).push().key;
            updates[`${REPORTING_DB_ROOT}/progressCards/${key}`] = {
                code,
                grade: (meta && meta.grade) || '',
                groupLabel: clsName,
                linkedStudent: sName,
                period: getLocalSettings().periodLabel || '',
                langLevel: 'Достатній рівень володіння мовою навчання',
                attText: '',
                finished: false,
                uaGaps: '', mathGaps: '', uaScores: {}, mathScores: {},
                achievedGoals: '', hardTopics: '', recommendations: '',
                addedAt: new Date().toISOString()
            };
            created++;
        });
        if (created === 0) return alert('Для всіх учнів цього класу картки вже існують!');
        db.ref().update(updates).then(() => alert(`Створено карток: ${created}`));
    }

    function buildSingleCardPrintHtml(c, isLast) {
        const settings = getLocalSettings();
        function buildTbl(comps, scoresObj) {
            const rows = comps.map(comp => {
                const s = (scoresObj || {})[comp.key] || {};
                const v1 = parseNum(s.init), v2 = parseNum(s.mid), v3 = parseNum(s.final);
                const latest = v3 !== null ? v3 : v2;
                const dyn = (v1 !== null && latest !== null) ? (latest - v1 > 0 ? `+${Math.round((latest - v1) * 10) / 10}` : `${Math.round((latest - v1) * 10) / 10}`) : '—';
                return `<tr><td>${esc(comp.label)}</td><td style="text-align:center;">${esc(s.init || '—')}</td><td style="text-align:center;">${esc(s.mid || '—')}</td><td style="text-align:center;">${esc(s.final || '—')}</td><td style="text-align:center; font-weight:bold;">${dyn}</td></tr>`;
            }).join('');
            const a1 = computeCardSubjectAvg(scoresObj, comps, 'init');
            const a2 = computeCardSubjectAvg(scoresObj, comps, 'mid');
            const a3 = computeCardSubjectAvg(scoresObj, comps, 'final');
            const latestA = a3 !== null ? a3 : a2;
            const dA = (a1 !== null && latestA !== null) ? Math.round((latestA - a1) * 10) / 10 : null;
            return `<table><thead><tr><th>Компетентність</th><th style="text-align:center;">Первинне</th><th style="text-align:center;">Проміжне</th><th style="text-align:center;">Підсумкове</th><th style="text-align:center;">Динаміка</th></tr></thead><tbody>
                ${rows}
                <tr style="font-weight:bold; background:#f1f5f9;"><td>Загальний середній результат</td><td style="text-align:center;">${a1 ?? '—'}</td><td style="text-align:center;">${a2 ?? '—'}</td><td style="text-align:center;">${a3 ?? '—'}</td><td style="text-align:center;">${dA !== null ? (dA > 0 ? '+' + dA : dA) : '—'}</td></tr>
            </tbody></table>`;
        }

        return `
            <div class="${isLast ? '' : 'rep-page-break'}" style="margin-bottom:20px;">
                <div style="text-align:center; border-bottom:2px solid #0f172a; padding-bottom:8px; margin-bottom:12px;">
                    <h2 style="margin:0; font-size:18px;">ІНДИВІДУАЛЬНА КАРТКА НАВЧАЛЬНОГО ПРОГРЕСУ УЧНЯ</h2>
                    ${settings.docBasis ? `<div style="font-size:12px; color:#475569;">${esc(settings.docBasis)}</div>` : ''}
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:12px; font-size:13px;">
                    <div><b>Код учня:</b> ${esc(c.code || '—')}</div>
                    <div><b>Клас:</b> ${esc(c.grade || '—')}</div>
                    <div><b>Навчальна група:</b> ${esc(c.groupLabel || '—')}</div>
                    <div><b>Період навчання:</b> ${esc(c.period || settings.periodLabel || '—')}</div>
                    <div><b>Відвідуваність:</b> ${esc(c.attText || '—')}</div>
                    <div><b>Мовна підтримка:</b> ${esc(c.langLevel || '—')}</div>
                </div>

                <h3 style="font-size:14px; margin:10px 0 4px 0;">1. Українська мова</h3>
                <div style="font-size:12px; margin-bottom:6px;"><b>Виявлені прогалини:</b> ${esc(c.uaGaps || '—')}</div>
                ${buildTbl(UA_COMPETENCIES, c.uaScores)}

                <h3 style="font-size:14px; margin:12px 0 4px 0;">2. Математика</h3>
                <div style="font-size:12px; margin-bottom:6px;"><b>Виявлені прогалини:</b> ${esc(c.mathGaps || '—')}</div>
                ${buildTbl(MATH_COMPETENCIES, c.mathScores)}

                <div style="margin-top:12px; font-size:13px;">
                    <div><b>Досягнуті навчальні цілі:</b> ${esc(c.achievedGoals || '—')}</div>
                    <div style="margin-top:4px;"><b>Теми, які залишаються складними:</b> ${esc(c.hardTopics || '—')}</div>
                    <div style="margin-top:4px;"><b>Рекомендації щодо подальшого навчання:</b> ${esc(c.recommendations || '—')}</div>
                </div>
                <div style="margin-top:20px; display:flex; justify-content:space-between; font-size:13px;">
                    <div>Виконавець: _______________________ ${esc(settings.executorSigner || '')}</div>
                    <div>Дата: ${new Date().toLocaleDateString('uk-UA')}</div>
                </div>
            </div>
        `;
    }

    // --- 4. ГРАФІК ТА КТП ---
    function renderScheduleAndKtpSection() {
        const sch = repData.schedule || {};
        document.getElementById('rep-sch-period').value = sch.period || getLocalSettings().periodLabel || '';
        document.getElementById('rep-sch-platform').value = sch.platform || 'Онлайн (Google Meet / Zoom)';
        document.getElementById('rep-sch-dates').value = sch.datesText || '';

        const rows = Array.isArray(sch.rows) && sch.rows.length > 0 ? sch.rows : [
            { group: 'Група 1 (1–2 класи)', category: '1–2 класи (до 6 учнів)', subject: 'Українська мова', time: 'Пн, Ср 15:00–16:00', perWeek: '2', totalHrs: '' },
            { group: 'Група 1 (1–2 класи)', category: '1–2 класи (до 6 учнів)', subject: 'Математика', time: 'Вт, Чт 15:00–16:00', perWeek: '2', totalHrs: '' },
            { group: 'Група 2 (3–4 класи)', category: '3–4 класи (до 6 учнів)', subject: 'Українська мова', time: 'Пн, Ср 16:30–17:30', perWeek: '2', totalHrs: '' },
            { group: 'Група 2 (3–4 класи)', category: '3–4 класи (до 6 учнів)', subject: 'Математика', time: 'Вт, Чт 16:30–17:30', perWeek: '2', totalHrs: '' }
        ];

        const wrap = document.getElementById('rep-sch-rows-wrap');
        wrap.innerHTML = `<div class="rep-table-scroll"><table><thead><tr>
            <th>Група</th><th>Категорія</th><th>Предмет</th><th>Дні та час</th><th>Год/тиж</th><th>План год. за період</th><th></th>
        </tr></thead><tbody id="rep-sch-tbody">${rows.map((r, i) => buildSchRowHtml(r, i)).join('')}</tbody></table></div>`;

        renderKtpPart();
    }

    function buildSchRowHtml(r, i) {
        return `<tr data-sch-row="1">
            <td><input type="text" class="sch-g" value="${esc(r.group || '')}" style="width:140px;"></td>
            <td><input type="text" class="sch-c" value="${esc(r.category || '')}" style="width:145px;"></td>
            <td><input type="text" class="sch-s" value="${esc(r.subject || '')}" style="width:130px;"></td>
            <td><input type="text" class="sch-t" value="${esc(r.time || '')}" style="width:155px;"></td>
            <td><input type="text" class="sch-w" value="${esc(r.perWeek || '')}" style="width:65px;"></td>
            <td><input type="number" class="sch-tot" value="${esc(r.totalHrs || '')}" style="width:80px;" min="0" step="0.5"></td>
            <td><button type="button" class="btn-delete" style="padding:5px 8px;" onclick="this.closest('tr').remove()">✕</button></td>
        </tr>`;
    }

    function collectScheduleFromDOM() {
        const rows = [];
        document.querySelectorAll('#rep-sch-tbody tr[data-sch-row]').forEach(tr => {
            rows.push({
                group: tr.querySelector('.sch-g').value.trim(),
                category: tr.querySelector('.sch-c').value.trim(),
                subject: tr.querySelector('.sch-s').value.trim(),
                time: tr.querySelector('.sch-t').value.trim(),
                perWeek: tr.querySelector('.sch-w').value.trim(),
                totalHrs: tr.querySelector('.sch-tot').value.trim()
            });
        });
        return {
            period: document.getElementById('rep-sch-period').value.trim(),
            platform: document.getElementById('rep-sch-platform').value.trim(),
            datesText: document.getElementById('rep-sch-dates').value.trim(),
            rows,
            addedAt: new Date().toISOString()
        };
    }

    function printScheduleA4() {
        const sch = collectScheduleFromDOM();
        const settings = getLocalSettings();
        let totalHrs = 0;
        const rowsHtml = sch.rows.map(r => {
            totalHrs += Number(r.totalHrs) || 0;
            return `<tr><td>${esc(r.group)}</td><td>${esc(r.category)}</td><td>${esc(r.subject)}</td><td>${esc(r.time)}</td><td style="text-align:center;">${esc(r.perWeek)}</td><td style="text-align:center;">${esc(r.totalHrs || '—')}</td></tr>`;
        }).join('');
        const html = `
            <div style="text-align:center; border-bottom:2px solid #0f172a; padding-bottom:10px; margin-bottom:14px;">
                <h2 style="margin:0; font-size:18px;">ПОГОДЖЕННЯ ГРАФІКА ТА ОБСЯГУ НАВЧАЛЬНИХ ЗАНЯТЬ</h2>
                ${settings.docBasis ? `<div style="font-size:12px; color:#475569;">${esc(settings.docBasis)}</div>` : ''}
            </div>
            <div style="margin-bottom:12px;">
                ${settings.executorTitle ? `<div><b>Виконавець:</b> ${esc(settings.executorTitle)}</div>` : ''}
                ${settings.clientTitle ? `<div><b>Замовник:</b> ${esc(settings.clientTitle)}</div>` : ''}
                <div><b>Період:</b> ${esc(sch.period || '—')} | <b>Формат:</b> ${esc(sch.platform || '—')} | <b>Тривалість заняття:</b> 60 хв</div>
            </div>
            <table><thead><tr><th>Група</th><th>Категорія</th><th>Предмет</th><th>Дні та час</th><th>Год/тиж</th><th>План год.</th></tr></thead>
            <tbody>${rowsHtml}</tbody></table>
            <div style="margin-top:10px;"><b>Загальна планова кількість годин:</b> ${totalHrs} год.</div>
            ${sch.datesText ? `<div style="margin-top:8px;"><b>Заплановані дати:</b> ${esc(sch.datesText)}</div>` : ''}
            <div style="margin-top:26px; display:flex; justify-content:space-between;">
                <div>Виконавець: ___________________ ${esc(settings.executorSigner || '')}</div>
                <div>Погоджено: ___________________ ${esc(settings.clientSigner || '')}</div>
            </div>
        `;
        printHtmlA4(html);
    }

    function getKtpMetaKey(grp, subj) {
        return `${grp}__${subj}`.replace(/[.#$\[\]\/]/g, '_');
    }

    function renderKtpPart() {
        const grp = document.getElementById('rep-ktp-group').value;
        const subj = document.getElementById('rep-ktp-subject').value;
        const mKey = getKtpMetaKey(grp, subj);
        const meta = (repData.ktpMeta || {})[mKey] || {};

        document.getElementById('rep-ktp-gaps').value = meta.gaps || '';
        document.getElementById('rep-ktp-method').value = meta.methodology || 'Діагностичні завдання, короткі тести та практичні вправи (первинне, проміжне, підсумкове оцінювання за співставною шкалою 0–100 балів).';
        document.getElementById('rep-ktp-target').value = meta.target || 'Підвищення результатів виконання діагностичних завдань щонайменше на 15–20% у не менш ніж 75% учнів із регулярним відвідуванням.';

        const items = Object.entries(repData.ktpItems || {})
            .map(([id, it]) => Object.assign({ id }, it))
            .filter(it => it.group === grp && it.subject === subj)
            .sort((a, b) => (Number(a.num) || 0) - (Number(b.num) || 0) || (a.date || '').localeCompare(b.date || ''));

        if (!editingKtpId) {
            document.getElementById('rep-ktp-num').value = items.length + 1;
        }

        const wrap = document.getElementById('rep-ktp-table-wrap');
        if (items.length === 0) {
            wrap.innerHTML = `<p style="text-align:center; color:#64748b; padding:14px;">У КТП для цієї групи та предмета ще немає тем.</p>`;
            return;
        }
        let html = `<table><thead><tr><th>№</th><th>Дата</th><th>Год.</th><th>Тема та зміст</th><th>Очікувані результати</th><th>Перевірка</th><th>Дії</th></tr></thead><tbody>`;
        items.forEach(it => {
            html += `<tr>
                <td>${esc(it.num)}</td>
                <td style="white-space:nowrap;">${esc(formatDMY(it.date))}</td>
                <td>${esc(it.hours)}</td>
                <td><b>${esc(it.topic)}</b></td>
                <td>${esc(it.outcomes || '—')}</td>
                <td>${esc(it.checkMethod || '—')}</td>
                <td>
                    <div class="btn-group">
                        <button type="button" class="btn-edit" onclick="window.__repEditKtp('${escJs(it.id)}')">✏️</button>
                        <button type="button" class="btn-delete" onclick="window.__repDeleteKtp('${escJs(it.id)}')">🗑️</button>
                    </div>
                </td>
            </tr>`;
        });
        html += `</tbody></table>`;
        wrap.innerHTML = html;
    }

    window.__repEditKtp = function(id) {
        const it = (repData.ktpItems || {})[id];
        if (!it) return;
        editingKtpId = id;
        document.getElementById('rep-ktp-num').value = it.num || 1;
        document.getElementById('rep-ktp-date').value = it.date || '';
        document.getElementById('rep-ktp-hours').value = it.hours || 1;
        document.getElementById('rep-ktp-topic').value = it.topic || '';
        document.getElementById('rep-ktp-outcomes').value = it.outcomes || '';
        document.getElementById('rep-ktp-check').value = it.checkMethod || '';
        document.getElementById('rep-ktp-add-item').innerText = '💾 Оновити рядок КТП';
        document.getElementById('rep-ktp-cancel-edit').style.display = 'inline-block';
    };

    window.__repDeleteKtp = function(id) {
        if (confirm('Видалити цей рядок із КТП?')) {
            db.ref(`${REPORTING_DB_ROOT}/ktpItems/${id}`).remove();
        }
    };

    function printKtpA4() {
        const grp = document.getElementById('rep-ktp-group').value;
        const subj = document.getElementById('rep-ktp-subject').value;
        const settings = getLocalSettings();
        const items = Object.entries(repData.ktpItems || {})
            .map(([id, it]) => Object.assign({ id }, it))
            .filter(it => it.group === grp && it.subject === subj)
            .sort((a, b) => (Number(a.num) || 0) - (Number(b.num) || 0));

        const rowsHtml = items.map(it => `<tr>
            <td style="text-align:center;">${esc(it.num)}</td>
            <td style="text-align:center;">${esc(formatDMY(it.date))}</td>
            <td style="text-align:center;">${esc(it.hours)}</td>
            <td>${esc(it.topic)}</td>
            <td>${esc(it.outcomes || '—')}</td>
            <td>${esc(it.checkMethod || '—')}</td>
        </tr>`).join('');

        const html = `
            <div style="text-align:center; border-bottom:2px solid #0f172a; padding-bottom:10px; margin-bottom:14px;">
                <h2 style="margin:0; font-size:18px;">КАЛЕНДАРНО-ТЕМАТИЧНИЙ ПЛАН ЗАНЯТЬ</h2>
                <div style="font-size:13px; color:#334155;">Група: <b>${esc(grp)}</b> | Предмет: <b>${esc(subj)}</b>${settings.docBasis ? ` | ${esc(settings.docBasis)}` : ''}</div>
            </div>
            <div style="margin-bottom:12px; font-size:13px;">
                <div><b>Виявлені освітні прогалини:</b> ${esc(document.getElementById('rep-ktp-gaps').value || '—')}</div>
                <div style="margin-top:4px;"><b>Методика оцінювання:</b> ${esc(document.getElementById('rep-ktp-method').value || '—')}</div>
                <div style="margin-top:4px;"><b>Очікувані цільові показники:</b> ${esc(document.getElementById('rep-ktp-target').value || '—')}</div>
            </div>
            <table><thead><tr><th>№</th><th>Дата</th><th>Год.</th><th>Тема та зміст заняття</th><th>Очікувані результати</th><th>Спосіб перевірки</th></tr></thead>
            <tbody>${rowsHtml || '<tr><td colspan="6" style="text-align:center;">План порожній</td></tr>'}</tbody></table>
            <div style="margin-top:24px; display:flex; justify-content:space-between;">
                <div>Укладач / Виконавець: ___________________ ${esc(settings.executorSigner || '')}</div>
                <div>Дата: ${new Date().toLocaleDateString('uk-UA')}</div>
            </div>
        `;
        printHtmlA4(html);
    }

    // --- 5. ЗВІТИ ТА РАХУНОК ---
    function populateLocalSettingsForm() {
        const s = getLocalSettings();
        document.getElementById('rep-set-basis').value = s.docBasis || '';
        document.getElementById('rep-set-period').value = s.periodLabel || '';
        document.getElementById('rep-set-rate').value = s.hourlyRate ?? 800;
        document.getElementById('rep-set-limit').value = s.budgetLimit || '';
        document.getElementById('rep-set-exec-title').value = s.executorTitle || '';
        document.getElementById('rep-set-exec-det').value = s.executorDetails || '';
        document.getElementById('rep-set-exec-sign').value = s.executorSigner || '';
        document.getElementById('rep-set-cli-title').value = s.clientTitle || '';
        document.getElementById('rep-set-cli-det').value = s.clientDetails || '';
        document.getElementById('rep-set-cli-sign').value = s.clientSigner || '';
        document.getElementById('rep-inv-num').value = s.invoiceNum || '1';
    }

    function renderReportsAndInvoiceSection() {
        const settings = getLocalSettings();
        const rate = Number(settings.hourlyRate) || 0;
        const limit = Number(settings.budgetLimit) || 0;

        const allLessons = Object.values(repData.lessons || {});
        let totalHrs = 0, uaHrs = 0, mathHrs = 0;
        allLessons.forEach(l => {
            if (!isBillableStatus(l.status)) return;
            const h = (Number(l.durationMin) || 60) / 60;
            totalHrs += h;
            if (l.subject === 'Українська мова') uaHrs += h;
            if (l.subject === 'Математика') mathHrs += h;
        });

        const totalSum = Math.round(totalHrs * rate * 100) / 100;
        const pctUsed = limit > 0 ? Math.min(100, Math.round((totalSum / limit) * 100)) : 0;
        const remain = limit > 0 ? Math.max(0, limit - totalSum) : null;

        document.getElementById('rep-budget-kpi').innerHTML = `
            <div class="rep-kpi"><div class="k-lbl">Усього зараховано годин</div><div class="k-val" style="color:#10b981;">${totalHrs.toFixed(1)} год.</div></div>
            <div class="rep-kpi"><div class="k-lbl">Мова / Математика</div><div class="k-val" style="font-size:17px; color:#38bdf8;">${uaHrs.toFixed(1)} / ${mathHrs.toFixed(1)} год.</div></div>
            <div class="rep-kpi"><div class="k-lbl">Нараховано всього</div><div class="k-val" style="color:#fbbf24;">${totalSum.toLocaleString('uk-UA')} грн</div></div>
            ${limit > 0 ? `<div class="rep-kpi">
                <div class="k-lbl">Залишок від ліміту (${pctUsed}% використано)</div>
                <div class="k-val" style="color:${remain === 0 ? '#ef4444' : '#38bdf8'};">${remain.toLocaleString('uk-UA')} грн</div>
                <div class="rep-progress-bar-bg"><div class="rep-progress-bar-fill" style="width:${pctUsed}%;"></div></div>
            </div>` : ''}
        `;

        // Завантажуємо чернетки
        const drafts = repData.reportDrafts || {};
        if (drafts.interim) {
            if (!document.getElementById('rep-int-diff').value) document.getElementById('rep-int-diff').value = drafts.interim.diff || '';
            if (!document.getElementById('rep-int-adj').value) document.getElementById('rep-int-adj').value = drafts.interim.adj || '';
        }
        if (drafts.final) {
            if (!document.getElementById('rep-fin-ua').value) document.getElementById('rep-fin-ua').value = drafts.final.ua || '';
            if (!document.getElementById('rep-fin-math').value) document.getElementById('rep-fin-math').value = drafts.final.math || '';
            if (!document.getElementById('rep-fin-issues').value) document.getElementById('rep-fin-issues').value = drafts.final.issues || '';
            if (!document.getElementById('rep-fin-rec').value) document.getElementById('rep-fin-rec').value = drafts.final.rec || '';
        }

        updateInvoicePreviewLine();
    }

    function updateInvoicePreviewLine() {
        const monthVal = document.getElementById('rep-inv-month').value;
        const rate = Number(getLocalSettings().hourlyRate) || 0;
        const list = getFilteredLessons(monthVal);
        let uaH = 0, mathH = 0;
        list.forEach(l => {
            if (!isBillableStatus(l.status)) return;
            const h = (Number(l.durationMin) || 60) / 60;
            if (l.subject === 'Українська мова') uaH += h;
            if (l.subject === 'Математика') mathH += h;
        });
        const totH = uaH + mathH;
        const totSum = Math.round(totH * rate * 100) / 100;
        document.getElementById('rep-inv-preview-line').innerHTML =
            `За <b>${esc(monthVal || 'увесь період')}</b>: Українська мова — <b>${uaH.toFixed(1).replace('.0', '')} год.</b>, Математика — <b>${mathH.toFixed(1).replace('.0', '')} год.</b> | Разом: <b>${totH.toFixed(1).replace('.0', '')} год. × ${rate} грн = ${totSum.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} грн</b>`;
    }

    function aggregateCardsStats() {
        const cards = Object.values(repData.progressCards || {});
        const byGroupSubj = {};
        const groupsSet = new Set();

        cards.forEach(c => {
            const g = c.groupLabel || 'Без групи';
            groupsSet.add(g);
            [
                { subj: 'Українська мова', comps: UA_COMPETENCIES, scores: c.uaScores },
                { subj: 'Математика', comps: MATH_COMPETENCIES, scores: c.mathScores }
            ].forEach(cfg => {
                const key = `${g}|||${cfg.subj}`;
                if (!byGroupSubj[key]) byGroupSubj[key] = { group: g, subject: cfg.subj, init: [], mid: [], fin: [], posCount: 0, comparedCount: 0 };
                const a1 = computeCardSubjectAvg(cfg.scores, cfg.comps, 'init');
                const a2 = computeCardSubjectAvg(cfg.scores, cfg.comps, 'mid');
                const a3 = computeCardSubjectAvg(cfg.scores, cfg.comps, 'final');
                if (a1 !== null) byGroupSubj[key].init.push(a1);
                if (a2 !== null) byGroupSubj[key].mid.push(a2);
                if (a3 !== null) byGroupSubj[key].fin.push(a3);
                const latest = a3 !== null ? a3 : a2;
                if (a1 !== null && latest !== null) {
                    byGroupSubj[key].comparedCount++;
                    if (latest > a1) byGroupSubj[key].posCount++;
                }
            });
        });

        const avg = arr => arr.length ? (Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10) : null;
        return {
            totalCards: cards.length,
            finishedCards: cards.filter(c => c.finished).length,
            rows: Object.values(byGroupSubj).map(r => {
                const m1 = avg(r.init), m2 = avg(r.mid), m3 = avg(r.fin);
                const latest = m3 !== null ? m3 : m2;
                const diff = (m1 !== null && latest !== null) ? Math.round((latest - m1) * 10) / 10 : null;
                return { group: r.group, subject: r.subject, m1, m2, m3, diff, posCount: r.posCount, comparedCount: r.comparedCount };
            }).sort((a, b) => a.group.localeCompare(b.group) || a.subject.localeCompare(b.subject))
        };
    }

    function computeOverallAttendanceSummary(monthFilter) {
        let pres = 0, counted = 0;
        for (const m in (attendanceData || {})) {
            if (monthFilter && m !== monthFilter) continue;
            for (const d in attendanceData[m]) {
                for (const cid in attendanceData[m][d]) {
                    if (cid === 'individual') continue;
                    for (const s in attendanceData[m][d][cid]) {
                        const st = attendanceData[m][d][cid][s];
                        if (st === 'present') { pres++; counted++; }
                        else if (st === 'absent') { counted++; }
                    }
                }
            }
        }
        return counted > 0 ? `${Math.round((pres / counted) * 100)}%` : '—';
    }

    function printInterimReportA4() {
        const settings = getLocalSettings();
        const lessons = Object.values(repData.lessons || {}).filter(l => isBillableStatus(l.status));
        const totalHrs = lessons.reduce((acc, l) => acc + (Number(l.durationMin) || 60) / 60, 0);
        const cardStats = aggregateCardsStats();
        const avgAtt = computeOverallAttendanceSummary('');

        const rowsHtml = cardStats.rows.map(r => `<tr>
            <td>${esc(r.group)} — ${esc(r.subject)}</td>
            <td style="text-align:center;">${r.m1 ?? '—'}</td>
            <td style="text-align:center;">${r.m2 ?? '—'}</td>
            <td style="text-align:center; font-weight:bold;">${r.diff !== null ? (r.diff > 0 ? '+' + r.diff : r.diff) : '—'}</td>
        </tr>`).join('');

        const html = `
            <div style="text-align:center; border-bottom:2px solid #0f172a; padding-bottom:10px; margin-bottom:14px;">
                <h2 style="margin:0; font-size:19px;">ПРОМІЖНИЙ ЗВІТ ПРО ПЕРЕБІГ НАВЧАННЯ</h2>
                ${settings.docBasis ? `<div style="font-size:12px; color:#475569;">${esc(settings.docBasis)}</div>` : ''}
            </div>
            <div style="margin-bottom:12px;">
                ${settings.executorTitle ? `<div><b>Виконавець:</b> ${esc(settings.executorTitle)}</div>` : ''}
                <div><b>Проведено зарахованих годин:</b> ${totalHrs.toFixed(1).replace('.0', '')} год. | <b>Охоплено учнів (за картками):</b> ${cardStats.totalCards} | <b>Середня відвідуваність:</b> ${avgAtt}</div>
            </div>
            <h3 style="font-size:15px;">1. Узагальнені результати проміжного оцінювання (знеособлено)</h3>
            <table><thead><tr><th>Група та предмет</th><th style="text-align:center;">Первинне (сер.)</th><th style="text-align:center;">Проміжне (сер.)</th><th style="text-align:center;">Динаміка</th></tr></thead>
            <tbody>${rowsHtml || '<tr><td colspan="4" style="text-align:center;">Дані оцінювання ще не внесені у картки прогресу</td></tr>'}</tbody></table>
            <h3 style="font-size:15px; margin-top:14px;">2. Виявлені труднощі</h3>
            <p style="white-space:pre-wrap;">${esc(document.getElementById('rep-int-diff').value || '—')}</p>
            <h3 style="font-size:15px; margin-top:12px;">3. Вжиті заходи та коригування навчальних планів</h3>
            <p style="white-space:pre-wrap;">${esc(document.getElementById('rep-int-adj').value || '—')}</p>
            <div style="margin-top:26px; display:flex; justify-content:space-between;">
                <div>Виконавець: _______________________ ${esc(settings.executorSigner || '')}</div>
                <div>Дата: ${new Date().toLocaleDateString('uk-UA')}</div>
            </div>
        `;
        printHtmlA4(html);
    }

    function printFinalReportA4() {
        const settings = getLocalSettings();
        const mode = document.getElementById('rep-fin-period-mode').value;
        const monthVal = mode === 'month' ? document.getElementById('rep-fin-month').value : '';
        const list = getFilteredLessons(monthVal);
        const rate = Number(settings.hourlyRate) || 0;

        const grpSubjMap = {};
        let totalLessonsCnt = 0, totalHrs = 0, pausesCnt = 0, reschedCnt = 0, noshowCnt = 0;

        list.forEach(l => {
            if (l.status === 'paused') pausesCnt++;
            if (l.status === 'rescheduled') reschedCnt++;
            if (l.status === 'noshow_paid') noshowCnt++;
            if (!isBillableStatus(l.status)) return;
            const h = (Number(l.durationMin) || 60) / 60;
            const k = `${l.group}|||${l.subject}`;
            if (!grpSubjMap[k]) grpSubjMap[k] = { group: l.group, subject: l.subject, cnt: 0, hrs: 0 };
            grpSubjMap[k].cnt++;
            grpSubjMap[k].hrs += h;
            totalLessonsCnt++;
            totalHrs += h;
        });

        const hoursRows = Object.values(grpSubjMap).sort((a, b) => a.group.localeCompare(b.group) || a.subject.localeCompare(b.subject)).map(r => {
            const sum = Math.round(r.hrs * rate * 100) / 100;
            return `<tr><td>${esc(r.group)}</td><td>${esc(r.subject)}</td><td style="text-align:center;">${r.cnt}</td><td style="text-align:center;">${r.hrs.toFixed(1).replace('.0', '')}</td><td style="text-align:right;">${rate.toFixed(2)}</td><td style="text-align:right;">${sum.toFixed(2)}</td></tr>`;
        }).join('');

        const totalSum = Math.round(totalHrs * rate * 100) / 100;
        const cardStats = aggregateCardsStats();
        const avgAtt = computeOverallAttendanceSummary(monthVal);

        const assessRows = cardStats.rows.map(r => `<tr>
            <td>${esc(r.group)} — ${esc(r.subject)}</td>
            <td style="text-align:center;">${r.m1 ?? '—'}</td>
            <td style="text-align:center;">${r.m2 ?? '—'}</td>
            <td style="text-align:center;">${r.m3 ?? '—'}</td>
            <td style="text-align:center; font-weight:bold;">${r.diff !== null ? (r.diff > 0 ? '+' + r.diff : r.diff) : '—'}</td>
            <td style="text-align:center;">${r.comparedCount > 0 ? `${r.posCount} із ${r.comparedCount}` : '—'}</td>
        </tr>`).join('');

        const titleTxt = mode === 'month' ? `ЗВІТ ПРО НАДАННЯ ПОСЛУГ ЗА ${monthVal}` : 'ПІДСУМКОВИЙ ЗВІТ ПРО НАДАННЯ ПОСЛУГ';

        const html = `
            <div style="text-align:center; border-bottom:2px solid #0f172a; padding-bottom:10px; margin-bottom:14px;">
                <h2 style="margin:0; font-size:18px;">${esc(titleTxt)}</h2>
                ${settings.docBasis ? `<div style="font-size:12px; color:#475569;">${esc(settings.docBasis)}</div>` : ''}
            </div>
            <div style="margin-bottom:12px; font-size:13px;">
                ${settings.clientTitle ? `<div><b>Замовник:</b> ${esc(settings.clientTitle)}</div>` : ''}
                ${settings.executorTitle ? `<div><b>Виконавець:</b> ${esc(settings.executorTitle)}</div>` : ''}
                <div><b>Період:</b> ${esc(monthVal || settings.periodLabel || '—')}</div>
            </div>

            <h3 style="font-size:14px;">1. Обсяг проведених занять та навчальних годин</h3>
            <table>
                <thead><tr><th>Група</th><th>Предмет</th><th>Занять</th><th>Годин (60 хв)</th><th>Ціна, грн</th><th>Сума, грн</th></tr></thead>
                <tbody>
                    ${hoursRows || '<tr><td colspan="6" style="text-align:center;">Занять за період немає</td></tr>'}
                    <tr style="font-weight:bold; background:#f1f5f9;"><td colspan="2">РАЗОМ</td><td style="text-align:center;">${totalLessonsCnt}</td><td style="text-align:center;">${totalHrs.toFixed(1).replace('.0', '')}</td><td>—</td><td style="text-align:right;">${totalSum.toFixed(2)}</td></tr>
                </tbody>
            </table>

            <h3 style="font-size:14px; margin-top:12px;">2. Охоплення учнів та відвідуваність</h3>
            <ul style="margin:4px 0 8px 18px;">
                <li>Розпочали навчання (оформлено карток прогресу): <b>${cardStats.totalCards}</b></li>
                <li>Завершили навчання (пройшли підсумкове оцінювання): <b>${cardStats.finishedCards}</b></li>
                <li>Узагальнена середня відвідуваність: <b>${avgAtt}</b></li>
            </ul>

            <h3 style="font-size:14px; margin-top:12px;">3. Узагальнені результати оцінювання (знеособлено)</h3>
            <table>
                <thead><tr><th>Група та предмет</th><th>Первинне</th><th>Проміжне</th><th>Підсумкове</th><th>Динаміка</th><th>Позитивна динаміка</th></tr></thead>
                <tbody>${assessRows || '<tr><td colspan="6" style="text-align:center;">Дані ще не внесені</td></tr>'}</tbody>
            </table>

            <h3 style="font-size:14px; margin-top:12px;">4. Опис прогресу за компетентностями</h3>
            <div><b>Українська мова:</b> ${esc(document.getElementById('rep-fin-ua').value || '—')}</div>
            <div style="margin-top:4px;"><b>Математика:</b> ${esc(document.getElementById('rep-fin-math').value || '—')}</div>

            <h3 style="font-size:14px; margin-top:12px;">5. Складнощі, перенесення та безпекові паузи</h3>
            <div>Зафіксовано у Журналі занять: перенесено — <b>${reschedCnt}</b>; безпекових пауз (тривог) — <b>${pausesCnt}</b>; неявок без попередження — <b>${noshowCnt}</b>.</div>
            <div style="margin-top:4px;">${esc(document.getElementById('rep-fin-issues').value || '')}</div>

            <h3 style="font-size:14px; margin-top:12px;">6. Рекомендації щодо подальшого навчання</h3>
            <p style="margin-top:4px; white-space:pre-wrap;">${esc(document.getElementById('rep-fin-rec').value || '—')}</p>

            <div style="margin-top:24px; display:flex; justify-content:space-between;">
                <div>Виконавець: _______________________ ${esc(settings.executorSigner || '')}</div>
                <div>Дата: ${new Date().toLocaleDateString('uk-UA')}</div>
            </div>
        `;
        printHtmlA4(html);
    }

    function printInvoiceA4() {
        const settings = getLocalSettings();
        const monthVal = document.getElementById('rep-inv-month').value;
        const invNum = document.getElementById('rep-inv-num').value.trim() || '1';
        const invDate = document.getElementById('rep-inv-date').value || todayYYYYMMDD();
        const periodTxt = document.getElementById('rep-inv-period-txt').value.trim() || monthVal;
        const rate = Number(settings.hourlyRate) || 0;

        // Зберігаємо номер рахунку локально
        saveLocalSettingsObj(Object.assign(settings, { invoiceNum: invNum }));

        const list = getFilteredLessons(monthVal);
        let uaH = 0, mathH = 0;
        list.forEach(l => {
            if (!isBillableStatus(l.status)) return;
            const h = (Number(l.durationMin) || 60) / 60;
            if (l.subject === 'Українська мова') uaH += h;
            if (l.subject === 'Математика') mathH += h;
        });

        const rows = [];
        if (uaH > 0) rows.push({ name: `Проведення занять з української мови за ${periodTxt}`, hrs: uaH, sum: Math.round(uaH * rate * 100) / 100 });
        if (mathH > 0) rows.push({ name: `Проведення занять з математики за ${periodTxt}`, hrs: mathH, sum: Math.round(mathH * rate * 100) / 100 });

        if (rows.length === 0) {
            return alert('За обраний місяць немає зарахованих занять у Журналі занять!');
        }

        const totalHrs = rows.reduce((a, r) => a + r.hrs, 0);
        const totalSum = rows.reduce((a, r) => a + r.sum, 0);

        const html = `
            <div style="margin-bottom:14px; font-size:13px;">
                <div style="font-weight:bold; font-size:14px;">Постачальник (Виконавець): ${esc(settings.executorTitle || '[Вкажіть у налаштуваннях]')}</div>
                <div style="white-space:pre-wrap; color:#334155; margin-top:3px;">${esc(settings.executorDetails || '')}</div>
            </div>
            <div style="text-align:center; border-top:2px solid #0f172a; border-bottom:2px solid #0f172a; padding:10px 0; margin:14px 0;">
                <h2 style="margin:0; font-size:20px;">РАХУНОК НА ОПЛАТУ № ${esc(invNum)}</h2>
                <div style="font-size:13px; margin-top:3px;">від ${esc(formatDMY(invDate))}</div>
            </div>
            <div style="margin-bottom:14px; font-size:13px;">
                <div><b>Платник (Замовник):</b> ${esc(settings.clientTitle || '[Вкажіть у налаштуваннях]')}</div>
                ${settings.clientDetails ? `<div style="white-space:pre-wrap; color:#334155; margin-top:3px;">${esc(settings.clientDetails)}</div>` : ''}
                ${settings.docBasis ? `<div style="margin-top:6px;"><b>Підстава:</b> ${esc(settings.docBasis)}</div>` : ''}
            </div>
            <table>
                <thead><tr><th>№</th><th>Найменування послуг</th><th>Од. вим.</th><th>Кількість</th><th>Ціна без ПДВ, грн</th><th>Сума без ПДВ, грн</th></tr></thead>
                <tbody>
                    ${rows.map((r, i) => `<tr>
                        <td style="text-align:center;">${i + 1}</td>
                        <td>${esc(r.name)}</td>
                        <td style="text-align:center;">Навч. год. (60 хв)</td>
                        <td style="text-align:center;">${r.hrs.toFixed(1).replace('.0', '')}</td>
                        <td style="text-align:right;">${rate.toFixed(2)}</td>
                        <td style="text-align:right;">${r.sum.toFixed(2)}</td>
                    </tr>`).join('')}
                    <tr style="font-weight:bold; background:#f1f5f9;">
                        <td colspan="3" style="text-align:right;">Всього до сплати (без ПДВ):</td>
                        <td style="text-align:center;">${totalHrs.toFixed(1).replace('.0', '')}</td>
                        <td></td>
                        <td style="text-align:right;">${totalSum.toFixed(2)}</td>
                    </tr>
                </tbody>
            </table>
            <div style="margin-top:12px; font-size:13px;">
                <div><b>Всього найменувань:</b> ${rows.length}, на суму <b>${totalSum.toFixed(2)} грн</b>, без ПДВ.</div>
                <div style="margin-top:6px;"><b>Призначення платежу:</b> Оплата за послуги з проведення навчальних занять за ${esc(periodTxt)}${settings.docBasis ? ` (${esc(settings.docBasis)})` : ''}, рахунок № ${esc(invNum)} від ${esc(formatDMY(invDate))}. Без ПДВ.</div>
            </div>
            <div style="margin-top:30px; display:flex; justify-content:space-between;">
                <div>Виконавець: ___________________________ ${esc(settings.executorSigner || '')}</div>
            </div>
        `;
        printHtmlA4(html);
    }

    // --- 6. БЕКАП СТАТИСТИКА ---
    function renderBackupSubTab() {
        const stats = typeof countDatabaseStats === 'function'
            ? countDatabaseStats(typeof cachedReportsData !== 'undefined' ? cachedReportsData : {}, typeof attendanceData !== 'undefined' ? attendanceData : {})
            : { reportsCount: 0, attCount: 0 };
        const lessonsCnt = Object.keys(repData.lessons || {}).length;
        const ktpCnt = Object.keys(repData.ktpItems || {}).length;
        const cardsCnt = Object.keys(repData.progressCards || {}).length;
        const codesCnt = Object.keys(repData.studentMeta || {}).length;

        document.getElementById('rep-backup-stats').innerHTML = `
            <div class="rep-kpi"><div class="k-lbl">Робіт ДЗ (ігри)</div><div class="k-val" style="color:#10b981;">${stats.reportsCount}</div></div>
            <div class="rep-kpi"><div class="k-lbl">Відміток відвідуваності</div><div class="k-val" style="color:#38bdf8;">${stats.attCount}</div></div>
            <div class="rep-kpi"><div class="k-lbl">Занять у Журналі обліку</div><div class="k-val" style="color:#a78bfa;">${lessonsCnt}</div></div>
            <div class="rep-kpi"><div class="k-lbl">Карток прогресу / Кодів</div><div class="k-val" style="color:#fbbf24;">${cardsCnt} / ${codesCnt}</div></div>
            <div class="rep-kpi"><div class="k-lbl">Рядків у КТП</div><div class="k-val">${ktpCnt}</div></div>
        `;
    }

    // --- ПІДВ’ЯЗКА ПОДІЙ ---
    function bindEvents() {
        // Перемикання підвкладок
        document.querySelectorAll('.rep-subtab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                activeSubTab = btn.dataset.sub;
                document.querySelectorAll('.rep-subtab-btn').forEach(b => b.classList.toggle('active', b === btn));
                document.querySelectorAll('.rep-panel').forEach(p => p.classList.toggle('active', p.id === `rep-sub-${activeSubTab}`));
                refreshAllReportingUI();
            });
        });

        // Початкові дати
        const today = todayYYYYMMDD();
        const curMonth = today.slice(0, 7);
        document.getElementById('rep-l-date').value = today;
        document.getElementById('rep-l-filter-month').value = curMonth;
        document.getElementById('rep-ar-month').value = curMonth;
        document.getElementById('rep-fin-month').value = curMonth;
        document.getElementById('rep-inv-month').value = curMonth;
        document.getElementById('rep-inv-date').value = today;

        // Журнал занять
        document.getElementById('rep-l-status').addEventListener('change', e => {
            document.getElementById('rep-l-pause-box').style.display = e.target.value === 'paused' ? 'grid' : 'none';
        });
        document.getElementById('rep-l-save-btn').addEventListener('click', saveLesson);
        document.getElementById('rep-lesson-cancel-edit').addEventListener('click', resetLessonForm);
        document.getElementById('rep-l-sync-att').addEventListener('click', syncAttendeesFromTab);
        document.getElementById('rep-l-filter-month').addEventListener('change', renderLessonsSection);
        document.getElementById('rep-l-filter-allmonths').addEventListener('click', () => {
            document.getElementById('rep-l-filter-month').value = '';
            renderLessonsSection();
        });
        document.getElementById('rep-l-filter-group').addEventListener('change', renderLessonsSection);
        document.getElementById('rep-l-filter-subject').addEventListener('change', renderLessonsSection);
        document.getElementById('rep-l-print-btn').addEventListener('click', printLessonsJournal);
        document.getElementById('rep-l-csv-btn').addEventListener('click', exportLessonsCSV);

        // Реєстр відвідуваності
        document.getElementById('rep-ar-class').addEventListener('change', renderAttendanceRegisterSection);
        document.getElementById('rep-ar-month').addEventListener('change', renderAttendanceRegisterSection);
        document.getElementById('rep-ar-anon').addEventListener('change', renderAttendanceRegisterSection);
        document.getElementById('rep-ar-autocodes').addEventListener('click', autoAssignClassCodes);
        document.getElementById('rep-ar-print').addEventListener('click', printAttendanceRegister);
        document.getElementById('rep-ar-csv').addEventListener('click', exportAttendanceRegisterCSV);

        // Картки прогресу
        document.getElementById('rep-pc-select').addEventListener('change', e => {
            currentCardId = e.target.value;
            renderSingleProgressCardEditor(currentCardId);
        });
        document.getElementById('rep-pc-new').addEventListener('click', createNewProgressCard);
        document.getElementById('rep-pc-sync-class').addEventListener('click', createCardsForClass);
        document.getElementById('rep-pc-print-one').addEventListener('click', () => {
            if (!currentCardId || !repData.progressCards[currentCardId]) return alert('Оберіть картку!');
            printHtmlA4(buildSingleCardPrintHtml(repData.progressCards[currentCardId], true));
        });
        document.getElementById('rep-pc-print-all').addEventListener('click', () => {
            const cards = Object.values(repData.progressCards || {}).sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }));
            if (cards.length === 0) return alert('Немає карток для друку!');
            printHtmlA4(cards.map((c, i) => buildSingleCardPrintHtml(c, i === cards.length - 1)).join(''));
        });

        // Графік і КТП
        document.getElementById('rep-sch-add-row').addEventListener('click', () => {
            document.getElementById('rep-sch-tbody').insertAdjacentHTML('beforeend', buildSchRowHtml({}, 0));
        });
        document.getElementById('rep-sch-save').addEventListener('click', () => {
            db.ref(`${REPORTING_DB_ROOT}/schedule`).set(collectScheduleFromDOM()).then(() => alert('Графік збережено!'));
        });
        document.getElementById('rep-sch-print').addEventListener('click', printScheduleA4);

        document.getElementById('rep-ktp-group').addEventListener('change', renderKtpPart);
        document.getElementById('rep-ktp-subject').addEventListener('change', renderKtpPart);
        document.getElementById('rep-ktp-save-meta').addEventListener('click', () => {
            const grp = document.getElementById('rep-ktp-group').value;
            const subj = document.getElementById('rep-ktp-subject').value;
            const mKey = getKtpMetaKey(grp, subj);
            db.ref(`${REPORTING_DB_ROOT}/ktpMeta/${mKey}`).set({
                gaps: document.getElementById('rep-ktp-gaps').value.trim(),
                methodology: document.getElementById('rep-ktp-method').value.trim(),
                target: document.getElementById('rep-ktp-target').value.trim(),
                addedAt: new Date().toISOString()
            }).then(() => alert('Опис КТП збережено!'));
        });
        document.getElementById('rep-ktp-add-item').addEventListener('click', () => {
            const topic = document.getElementById('rep-ktp-topic').value.trim();
            if (!topic) return alert('Введіть тему заняття!');
            const payload = {
                group: document.getElementById('rep-ktp-group').value,
                subject: document.getElementById('rep-ktp-subject').value,
                num: Number(document.getElementById('rep-ktp-num').value) || 1,
                date: document.getElementById('rep-ktp-date').value,
                hours: Number(document.getElementById('rep-ktp-hours').value) || 1,
                topic,
                outcomes: document.getElementById('rep-ktp-outcomes').value.trim(),
                checkMethod: document.getElementById('rep-ktp-check').value.trim(),
                addedAt: new Date().toISOString()
            };
            const ref = editingKtpId
                ? db.ref(`${REPORTING_DB_ROOT}/ktpItems/${editingKtpId}`).set(payload)
                : db.ref(`${REPORTING_DB_ROOT}/ktpItems`).push(payload);
            ref.then(() => {
                editingKtpId = null;
                document.getElementById('rep-ktp-topic').value = '';
                document.getElementById('rep-ktp-outcomes').value = '';
                document.getElementById('rep-ktp-check').value = '';
                document.getElementById('rep-ktp-add-item').innerText = '➕ Додати рядок у КТП';
                document.getElementById('rep-ktp-cancel-edit').style.display = 'none';
            });
        });
        document.getElementById('rep-ktp-cancel-edit').addEventListener('click', () => {
            editingKtpId = null;
            document.getElementById('rep-ktp-topic').value = '';
            document.getElementById('rep-ktp-outcomes').value = '';
            document.getElementById('rep-ktp-check').value = '';
            document.getElementById('rep-ktp-add-item').innerText = '➕ Додати рядок у КТП';
            document.getElementById('rep-ktp-cancel-edit').style.display = 'none';
        });
        document.getElementById('rep-ktp-print').addEventListener('click', printKtpA4);
        document.getElementById('rep-ktp-csv').addEventListener('click', () => {
            const grp = document.getElementById('rep-ktp-group').value;
            const subj = document.getElementById('rep-ktp-subject').value;
            const items = Object.values(repData.ktpItems || {}).filter(it => it.group === grp && it.subject === subj).sort((a, b) => (Number(a.num) || 0) - (Number(b.num) || 0));
            const rows = [['№', 'Дата', 'Годин', 'Тема та зміст', 'Очікувані результати', 'Спосіб перевірки']];
            items.forEach(it => rows.push([it.num, it.date || '', it.hours || 1, it.topic || '', it.outcomes || '', it.checkMethod || '']));
            downloadCSV(`ktp_${todayYYYYMMDD()}.csv`, rows);
        });

        // Звіти та рахунок
        populateLocalSettingsForm();
        document.getElementById('rep-set-save').addEventListener('click', () => {
            saveLocalSettingsObj({
                docBasis: document.getElementById('rep-set-basis').value.trim(),
                periodLabel: document.getElementById('rep-set-period').value.trim(),
                hourlyRate: Number(document.getElementById('rep-set-rate').value) || 0,
                budgetLimit: document.getElementById('rep-set-limit').value.trim(),
                executorTitle: document.getElementById('rep-set-exec-title').value.trim(),
                executorDetails: document.getElementById('rep-set-exec-det').value.trim(),
                executorSigner: document.getElementById('rep-set-exec-sign').value.trim(),
                clientTitle: document.getElementById('rep-set-cli-title').value.trim(),
                clientDetails: document.getElementById('rep-set-cli-det').value.trim(),
                clientSigner: document.getElementById('rep-set-cli-sign').value.trim(),
                invoiceNum: document.getElementById('rep-inv-num').value.trim() || '1'
            });
            alert('Налаштування збережено локально на цьому комп’ютері!');
            renderLessonsSection();
            renderReportsAndInvoiceSection();
        });
        document.getElementById('rep-set-clear').addEventListener('click', () => {
            if (confirm('Очистити всі локально збережені реквізити з цього браузера?')) {
                localStorage.removeItem(LOCAL_SETTINGS_KEY);
                populateLocalSettingsForm();
                renderReportsAndInvoiceSection();
            }
        });
        document.getElementById('rep-int-save').addEventListener('click', () => {
            db.ref(`${REPORTING_DB_ROOT}/reportDrafts/interim`).set({
                diff: document.getElementById('rep-int-diff').value.trim(),
                adj: document.getElementById('rep-int-adj').value.trim(),
                addedAt: new Date().toISOString()
            }).then(() => alert('Чернетку проміжного звіту збережено!'));
        });
        document.getElementById('rep-gen-interim-print').addEventListener('click', printInterimReportA4);
        document.getElementById('rep-fin-period-mode').addEventListener('change', e => {
            document.getElementById('rep-fin-month').style.display = e.target.value === 'month' ? 'inline-block' : 'none';
        });
        document.getElementById('rep-fin-save').addEventListener('click', () => {
            db.ref(`${REPORTING_DB_ROOT}/reportDrafts/final`).set({
                ua: document.getElementById('rep-fin-ua').value.trim(),
                math: document.getElementById('rep-fin-math').value.trim(),
                issues: document.getElementById('rep-fin-issues').value.trim(),
                rec: document.getElementById('rep-fin-rec').value.trim(),
                addedAt: new Date().toISOString()
            }).then(() => alert('Чернетку підсумкового звіту збережено!'));
        });
        document.getElementById('rep-gen-final-print').addEventListener('click', printFinalReportA4);
        document.getElementById('rep-inv-month').addEventListener('change', updateInvoicePreviewLine);
        document.getElementById('rep-inv-print').addEventListener('click', printInvoiceA4);

        // Повний бекап
        document.getElementById('rep-bk-download').addEventListener('click', () => {
            const incl = document.getElementById('rep-bk-include-local').checked;
            window.downloadFullBackup(incl);
        });
        document.getElementById('rep-bk-restore-merge').addEventListener('change', e => window.restoreFromBackupFile(e, 'merge'));
        document.getElementById('rep-bk-restore-overwrite').addEventListener('change', e => window.restoreFromBackupFile(e, 'overwrite'));
    }

    function refreshAllReportingUI() {
        renderLessonsSection();
        if (activeSubTab === 'attendance_reg') renderAttendanceRegisterSection();
        if (activeSubTab === 'progress') renderProgressCardsSection();
        if (activeSubTab === 'ktp') renderScheduleAndKtpSection();
        if (activeSubTab === 'reports') renderReportsAndInvoiceSection();
        if (activeSubTab === 'backup') renderBackupSubTab();
    }

    function init() {
        if (typeof db === 'undefined') {
            console.error('Reporting module: Firebase db не знайдено.');
            return;
        }
        injectStyles();
        injectDOM();
        hookExistingFunctions();
        bindEvents();

        db.ref(REPORTING_DB_ROOT).on('value', snap => {
            const val = snap.val() || {};
            repData = {
                lessons: val.lessons || {},
                ktpMeta: val.ktpMeta || {},
                ktpItems: val.ktpItems || {},
                schedule: val.schedule || {},
                studentMeta: val.studentMeta || {},
                progressCards: val.progressCards || {},
                reportDrafts: val.reportDrafts || {}
            };
            refreshAllReportingUI();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
