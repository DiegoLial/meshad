# @meshad/cli

O client do MeshAd: detecta a espera do agente de IA, mostra ads no rodapé do terminal (linha única, bloco ou painel com borda — cores e emoji configuráveis) e os remove no instante em que a resposta chega.

Zero dependências externas — o contrato de telemetria (`packages/schema`) é vendorizado em `src/schema/` para que este pacote seja instalável fora do monorepo (`npm install -g`). Mantenha os dois em sync — `test/schema-sync.test.js` garante isso. Este diretório também é espelhado publicamente em `github.com/DiegoLial/meshad/cli` para instalação por quem não tem acesso ao core privado — copie as mudanças de `src/`, `bin/` e `package.json` para lá ao alterar o CLI.

## Instalar e usar (dentro do monorepo)

```bash
npm install
node bin/meshad.js init          # opt-in explícito + registro
node bin/meshad.js demo          # agente simulado, fluxo real de anúncio
node bin/meshad.js run -- aider  # wrapper para qualquer CLI
node bin/meshad.js earnings      # seus ganhos, direto do ledger
npm test                           # testes (FSM, telemetria, cache, render, schema-sync, e2e)
```

## Jogar enquanto o agente pensa (`meshad play`)

```bash
meshad play runner     # Wait Runner: 1 tecla (Espaço) pula, sessões curtas, P pausa
meshad play termo      # Termo Dev: a palavra dev do dia (5 letras, 6 tentativas)
meshad play snake      # Snake: setas / WASD / hjkl
meshad play flappy     # Flappy Term: Espaço ou ↑ bate asas
meshad play blocks     # Meshad Blocks: ←→ move, ↑/X gira, Z gira ao contrário, ↓ desce, Espaço solta
meshad play slide      # Slide 2048: setas / WASD / hjkl (Esc guarda os pontos)
meshad play chess      # Mate do Dia: digite o lance (e2e4, Nf3) + Enter
meshad play            # menu com todos os jogos, placar e manchetes
meshad run --play -- claude   # dentro do tmux: abre o jogo num split quando a espera passa do min_wait
```

`play` é um processo separado, com TTY próprio (tela alternativa): ele nunca lê nem repassa o stdin do agente. A única ponte com `meshad run --play` é o arquivo `play-state.json` no diretório de config (`{"state":"waiting"|"idle","ts":…}`, escrita atômica) — o jogo congela quando o agente está respondendo e retoma quando volta a pensar; Espaço continua jogando (free-play). Sem `run --play`, `meshad play` é free-play puro: nenhuma telemetria, nenhuma impressão, nenhuma rede. Mesma data UTC + mesmo jogo = mesma semente (mesma palavra, mesmos obstáculos); ao fim sai uma string para copiar, sem link.

Visual: cores em truecolor / 256 / 16 conforme `COLORTERM` e `TERM`; `NO_COLOR` (qualquer valor) ou saída sem TTY = texto simples, ainda jogável. O céu do jogo esquenta conforme o agente demora (só cosmético — não altera o motor nem o replay). Quando a resposta chega, aparece um cartão "SUA RESPOSTA ESTÁ PRONTA" (Espaço continua, Esc volta ao agente). Streaks e recordes ficam só em `play-streaks.json` (0600, local, nunca enviados). Manchetes: `meshad` → Manchetes (filtro local pelos seus tópicos; `MESHAD_NEWS_FIXTURE=<arquivo.json>` troca a fonte por um arquivo, só para demos).

Patrocínio: um anúncio `ascii_panel` pode trazer `render.game` (`runner` | `termo`) dentro da assinatura Ed25519. O `play` reverifica a assinatura com a chave pública local antes de desenhar a skin; se falhar, joga sem skin. Fora do tmux, `run --play` só escreve o estado e avisa para abrir `meshad play` em outro painel (nenhuma impressão é contada).

## Instalar como usuário final (fora do monorepo)

```bash
curl -fsSL https://meshad.io/install | sh   # 0.5.0, com os jogos, o anúncio de espera e as notícias
meshad demo                                  # anúncios fictícios, offline, sem conta
meshad init
```

O pacote no npm ainda não está nesta versão (não use `npm`/`npx` por enquanto).
A partir deste diretório (ou de um clone do mirror público): `npm install -g .`.

## Privacidade em 10 linhas

1. Só 5 sinais saem da máquina: início/fim de processamento, duração, um UUID anônimo rotacionável e o tipo do terminal.
2. Todo evento é validado contra o schema público (`packages/schema`) **antes** de entrar na fila — um evento fora do contrato lança exceção (bug, não condição).
3. `meshad status --explain` mostra o último batch enviado, byte a byte, e o destino.
4. O wrapper `run` observa apenas o *timing* dos bytes do seu comando — os chunks passam intactos, o detector vê só timestamps.
5. Anúncio só renderiza com assinatura Ed25519 válida da rede; payload adulterado é descartado silenciosamente.
6. Sem TTY → nenhum render. Sem rede → nenhum anúncio, nenhum erro. Fail-closed sempre.
7. `meshad pause forever` e `meshad uninstall` fazem exatamente o que dizem, sem dark patterns.
8. Frequency cap local (default 6/h) aplicado antes de qualquer request.
9. Impressão só conta com ≥2s de exibição durante espera real.
10. Config legível em `~/.config/meshad/config.json` (0600), nunca ofuscada.

## Idiomas

O CLI fala inglês e português (pt-BR). Resolução: `MESHAD_LANG` → `meshad config lang pt-BR` → `LANG` do sistema → inglês. Fluxos traduzidos: consentimento do `init`, `demo`, `earnings`, `status` (incl. `--explain`), `pause`/`resume`, `uninstall`. As telas de `--help` permanecem em inglês (convenção de ferramentas dev). Catálogos em `src/i18n.js` — chave ausente cai para o inglês, nunca quebra.
