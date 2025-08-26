       // ===============================
        // Utilidades de UI e métricas
        // ===============================
        const $ = (sel) => document.querySelector(sel);
        const logBox = $('#log');
        const ui = {
            status: $('#status'), totalTime: $('#totalTime'),
            ping: $('#ping'), jitter: $('#jitter'), down: $('#down'), up: $('#up'),
            pingBar: $('#pingBar'), jitterBar: $('#jitterBar'), downBar: $('#downBar'), upBar: $('#upBar'),
            startBtn: $('#startBtn'), stopBtn: $('#stopBtn'), copyBtn: $('#copyBtn'),
            threads: $('#threads'), dlSeconds: $('#dlSeconds'), ulSeconds: $('#ulSeconds'), sizeMB: $('#sizeMB'),
            dlEndpoint: $('#dlEndpoint'), ulEndpoint: $('#ulEndpoint'), pingEndpoint: $('#pingEndpoint'), samples: $('#samples')
        };

        function log(msg, type = 'info') {
            const time = new Date().toLocaleTimeString();
            const line = document.createElement('div');
            line.innerHTML = `<span class="muted">[${time}]</span> ${msg}`;
            if (type === 'error') line.style.color = 'var(--danger)';
            if (type === 'warn') line.style.color = 'var(--warn)';
            logBox.appendChild(line); logBox.scrollTop = logBox.scrollHeight;
            console[type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'log'](msg);
        }

        function formatMbps(bytesPerSec) {
            const bits = bytesPerSec * 8; // bits/s
            const mbps = bits / 1_000_000; // Mbps (decimal)
            return mbps;
        }
        function round(n, d = 1) { return Number(n.toFixed(d)); }

        function setMetric(el, bar, value, unit) {
            el.textContent = (value == null ? '—' : round(value, unit === 'Mbps' ? 1 : 1));
            const v = Math.min(100, unit === 'Mbps' ? (value / 200 * 100) : (100 - Math.min(100, value))) // barras referenciais
            bar.style.width = `${Math.max(0, v)}%`;
        }

        function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length }
        function stdev(arr) { const m = mean(arr); return Math.sqrt(mean(arr.map(x => (x - m) ** 2))) }

        // ===============================
        // Controladores globais
        // ===============================
        let aborters = [];
        let running = false;

        function resetUI() {
            setMetric(ui.ping, ui.pingBar, null, 'ms');
            setMetric(ui.jitter, ui.jitterBar, null, 'ms');
            setMetric(ui.down, ui.downBar, null, 'Mbps');
            setMetric(ui.up, ui.upBar, null, 'Mbps');
            ui.totalTime.textContent = '0.0 s';
            logBox.textContent = '';
            ui.status.textContent = 'Pronto';
        }

        function abortAll() {
            aborters.forEach(a => a.abort());
            aborters = [];
        }

        // ===============================
        // PING/JITTER
        // ===============================
        async function testPing(url, samples = 10) {
            log(`Iniciando ping: ${url} (${samples} amostras)`);
            const times = [];
            const controller = new AbortController();
            aborters.push(controller);
            for (let i = 0; i < samples && running; i++) {
                try {
                    const t0 = performance.now();
                    // Usamos cache-busting para evitar cache e medir RTT real
                    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'r=' + Math.random(), { cache: 'no-store', signal: controller.signal });
                    // Apenas lê um pequeno corpo (se houver)
                    await res.text();
                    const dt = performance.now() - t0;
                    times.push(dt);
                    setMetric(ui.ping, ui.pingBar, mean(times), 'ms');
                    setMetric(ui.jitter, ui.jitterBar, times.length > 1 ? stdev(times) : 0, 'ms');
                } catch (err) { if (controller.signal.aborted) throw new Error('Ping abortado'); log(`Falha ping #${i + 1}: ${err.message}`, 'warn'); }
            }
            const m = times.length ? mean(times) : null;
            const j = times.length > 1 ? stdev(times) : null;
            log(`Ping concluído. média=${m ? round(m) : '—'} ms, jitter=${j ? round(j) : '—'} ms`);
            return { ping: m, jitter: j };
        }

        // ===============================
        // DOWNLOAD
        // ===============================
        async function testDownload(baseUrl, seconds, threads, sizeMB) {
            log(`Iniciando download por ${seconds}s, ${threads} conexões, ~${sizeMB}MB por requisição`);
            const endAt = performance.now() + seconds * 1000;
            let totalBytes = 0;
            let active = 0;
            const tasks = [];

            async function worker(id) {
                const controller = new AbortController();
                aborters.push(controller);
                while (running && performance.now() < endAt) {
                    const size = Math.max(1, sizeMB | 0) * 1024 * 1024;
                    const url = `${baseUrl}?bytes=${size}&r=${Math.random()}`;
                    try {
                        active++; const t0 = performance.now();
                        const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
                        const reader = res.body.getReader();
                        let received = 0;
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break; received += value.byteLength; totalBytes += value.byteLength;
                            const elapsed = (performance.now() - t0) / 1000;
                            if (elapsed > 0) { setMetric(ui.down, ui.downBar, formatMbps(received / elapsed), 'Mbps'); }
                        }
                    } catch (err) { if (controller.signal.aborted) break; log(`Download[${id}] erro: ${err.message}`, 'warn'); }
                    finally { active--; }
                }
            }

            for (let i = 0; i < threads; i++) { tasks.push(worker(i + 1)); }
            await Promise.allSettled(tasks);
            const duration = seconds; // aproximado
            const mbps = formatMbps(totalBytes / duration);
            log(`Download total: ${(totalBytes / 1_000_000).toFixed(1)} MB em ${duration}s ≈ ${round(mbps, 1)} Mbps`);
            return { mbps };
        }

        // ===============================
        // UPLOAD
        // ===============================
        function makeRandomBlob(size) {
            const buf = new Uint8Array(size);
            crypto.getRandomValues(buf);
            return new Blob([buf], { type: 'application/octet-stream' });
        }

        async function testUpload(url, seconds, threads, sizeMB) {
            log(`Iniciando upload por ${seconds}s, ${threads} conexões, ~${sizeMB}MB por requisição`);
            const endAt = performance.now() + seconds * 1000;
            let totalBytes = 0;

            async function worker(id) {
                const controller = new AbortController();
                aborters.push(controller);
                while (running && performance.now() < endAt) {
                    const size = Math.max(1, sizeMB | 0) * 1024 * 1024;
                    const blob = makeRandomBlob(size);
                    const t0 = performance.now();
                    try {
                        const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'r=' + Math.random(), {
                            method: 'POST', body: blob, signal: controller.signal, cache: 'no-store'
                        });
                        // alguns endpoints retornam algo; lemos para fechar conexão corretamente
                        try { await res.arrayBuffer(); } catch { }
                        const elapsed = (performance.now() - t0) / 1000;
                        totalBytes += size;
                        if (elapsed > 0) { setMetric(ui.up, ui.upBar, formatMbps(size / elapsed), 'Mbps'); }
                    } catch (err) { if (controller.signal.aborted) break; log(`Upload[${id}] erro: ${err.message}`, 'warn'); }
                }
            }

            await Promise.allSettled(Array.from({ length: threads }, (_, i) => worker(i + 1)));
            const duration = seconds;
            const mbps = formatMbps(totalBytes / duration);
            log(`Upload total: ${(totalBytes / 1_000_000).toFixed(1)} MB em ${duration}s ≈ ${round(mbps, 1)} Mbps`);
            return { mbps };
        }

        // ===============================
        // Fluxo principal
        // ===============================
        async function runTest() {
            if (running) return;
            resetUI();
            running = true;
            ui.status.textContent = 'Testando…';
            const tStart = performance.now();

            const cfg = {
                threads: Math.max(1, parseInt(ui.threads.value || '4', 10)),
                dlSeconds: Math.max(2, parseInt(ui.dlSeconds.value || '8', 10)),
                ulSeconds: Math.max(2, parseInt(ui.ulSeconds.value || '8', 10)),
                sizeMB: Math.max(1, parseInt(ui.sizeMB.value || '8', 10)),
                dlEndpoint: ui.dlEndpoint.value.trim(),
                ulEndpoint: ui.ulEndpoint.value.trim(),
                pingEndpoint: ui.pingEndpoint.value.trim(),
                samples: Math.max(5, parseInt(ui.samples.value || '10', 10))
            };
            log('Configuração: ' + JSON.stringify(cfg));

            try {
                // 1) Ping/Jitter
                const { ping, jitter } = await testPing(cfg.pingEndpoint, cfg.samples);
                if (ping != null) setMetric(ui.ping, ui.pingBar, ping, 'ms');
                if (jitter != null) setMetric(ui.jitter, ui.jitterBar, jitter, 'ms');

                // 2) Download
                if (!running) throw new Error('Interrompido');
                const dl = await testDownload(cfg.dlEndpoint, cfg.dlSeconds, cfg.threads, cfg.sizeMB);
                if (dl.mbps != null) setMetric(ui.down, ui.downBar, dl.mbps, 'Mbps');

                // 3) Upload
                if (!running) throw new Error('Interrompido');
                const ul = await testUpload(cfg.ulEndpoint, cfg.ulSeconds, cfg.threads, cfg.sizeMB);
                if (ul.mbps != null) setMetric(ui.up, ui.upBar, ul.mbps, 'Mbps');

                ui.status.textContent = 'Concluído';
            } catch (err) {
                log('Erro no teste: ' + err.message, 'error');
                ui.status.textContent = 'Erro';
            } finally {
                running = false; abortAll();
                const total = (performance.now() - tStart) / 1000;
                ui.totalTime.textContent = `${total.toFixed(1)} s`;
            }
        }

        function stopTest() {
            if (!running) { log('Nada para parar'); return; }
            running = false; abortAll(); ui.status.textContent = 'Interrompido'; log('Teste interrompido pelo usuário', 'warn');
        }

        async function copyResults() {
            const text = `Resultados do Teste:\n` +
                `Ping: ${ui.ping.textContent} ms\n` +
                `Jitter: ${ui.jitter.textContent} ms\n` +
                `Download: ${ui.down.textContent} Mbps\n` +
                `Upload: ${ui.up.textContent} Mbps\n` +
                `Duração total: ${ui.totalTime.textContent}`;
            try {
                await navigator.clipboard.writeText(text);
                log('Resultados copiados para a área de transferência.');
            } catch (err) { log('Falha ao copiar: ' + err.message, 'warn'); }
        }

        ui.startBtn.addEventListener('click', runTest);
        ui.stopBtn.addEventListener('click', stopTest);
        ui.copyBtn.addEventListener('click', copyResults);

        // melhora a responsividade da barra em animações rápidas
        [ui.downBar, ui.upBar, ui.pingBar, ui.jitterBar].forEach(el => el.style.transition = 'width .25s ease');

        // Auto-preferências: reduz valores para 3G/4G
        if (navigator.connection) {
            const type = navigator.connection.effectiveType || '';
            if (['slow-2g', '2g', '3g'].includes(type)) {
                ui.threads.value = 2; ui.sizeMB.value = 2; ui.dlSeconds.value = 6; ui.ulSeconds.value = 6;
                log(`Rede detectada: ${type}. Ajustando parâmetros para evitar consumo exagerado.`, 'warn');
            }
        }