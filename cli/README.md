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

## Instalar como usuário final (fora do monorepo)

```bash
npm install -g .          # a partir deste diretório, ou de um clone do mirror público
meshad init
```

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
