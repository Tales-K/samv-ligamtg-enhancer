# SAMV LigaMtg Enhancer

**Uma experiência melhor no LigaMagic — e nos sites que você já usa para montar seus decks.**

O **SAMV LigaMtg Enhancer** é uma extensão de navegador feita pela **Sociedade Amigos do Vale (SAMV)** que mostra o preço em reais do LigaMagic direto no Archidekt, Moxfield e Scryfall, e deixa o próprio LigaMagic mais rápido de usar: menu enxuto, deck ordenado por preço, filtros de compra que já vêm do jeito que você quer e uma forma de sair da "Compra por Lista" com a lista de compras pronta pra qualquer lugar.

Sem loja, sem conta, sem build: é [carregar a pasta no Chrome](#instalação) e pronto.

---

## O que isso resolve

- Você monta decks em sites gringos mas compra no Brasil
- Os preços em dólar não dizem nada sobre o mercado nacional
- O próprio LigaMagic tem fricções do dia a dia — menu com abas que você nunca usa, deck view sem ordenar por preço, filtros de compra que você reconfigura toda vez

Os dois problemas, resolvidos pela mesma extensão.

---

## No LigaMagic

### Menu principal sob medida
Adiciona uma aba **"Meus Decks"** direto no menu principal (atalho para seus decks salvos) e remove a aba **"Leilões"**, se você não usa. Ambos configuráveis — pode desligar qualquer um dos dois.

### Visualização de deck por Preço
Uma nova aba **"Preço"** na página do deck, ao lado de Padrão/Cor/Custo/etc., que ordena as cartas por valor sem misturar mainboard, sideboard e maybeboard. Dá pra definir qual aba abre automaticamente ao entrar em qualquer deck.

### Copiar Deck em vez de Gerar Imagem
O botão "Gerar Imagem" da página do deck vira **"Copiar Deck"**: um clique copia a lista completa (mainboard + sideboard) para a área de transferência em formato de texto puro (`<quantidade> <nome>`), pronta para colar onde precisar.

### Filtros automáticos na Compra por Lista
Na página "Compra por Lista", configure de uma vez os valores padrão de Idiomas, Extras, Qualidade e as opções de "ignorar sem estoque" / "ignorar pré-venda" — aplicados automaticamente toda vez que a página carrega. Também dá pra deixar o plugin apenas lembrar da última seleção manual que você fez, sem precisar fixar valores fixos.

### Busca em lojas customizadas
Na mesma página, cole a URL de qualquer loja da Liga pra incluí-la na busca — sem precisar favoritá-la de verdade nem mexer nos seus favoritos reais. As lojas ficam guardadas numa lista própria, prontas pra marcar ou desmarcar na próxima busca.

### Copiar Lista de Compras
Depois de pesquisar, um botão ao lado de "Finalizar Compra" copia todas as cartas que sobraram no resultado — já refletindo qualquer carta ou loja que você removeu na tela — em formato de lista de Magic, separadas por loja. Por padrão copia só quantidade e nome em inglês; dá pra incluir versão, qualidade, idioma e preço de cada carta, e a extensão lembra da sua última escolha.

---

## Nos sites parceiros (Archidekt, Moxfield, Scryfall)

### Preço em R$ ao lado de cada carta
O preço mínimo em reais aparece diretamente na listagem do seu deck, sem precisar sair da página ou abrir nenhuma outra aba. O preço é salvo no seu navegador na primeira vez que você visita a carta no LigaMagic — não existe uma base de preços compartilhada entre usuários.

### Link direto para o LigaMagic em cada carta (opcional)
Clicou no preço? Você já está na página certa no LigaMagic para comprar, comparar vendedores ou verificar o histórico. Funciona até para cartas sem preço cadastrado — elas também viram link. Esse comportamento pode ser desligado nas configurações, se você preferir que o preço seja só informativo.

### Saiba se o preço está fresco ou defasado
A cor do preço indica há quanto tempo ele foi registrado:
- **Verde** — menos de 7 dias. Pode confiar.
- **Amarelo** — entre 7 e 30 dias. Vale checar.
- **Vermelho** — mais de 30 dias. Consulte o LigaMagic diretamente.

### Total do deck e por grupo em BRL
Veja o custo estimado do deck inteiro em reais — e o subtotal de cada seção (Criaturas, Feitiços, Terrenos...) — sem precisar calcular nada na mão.

---

## Tudo configurável

O ícone da extensão abre um painel onde cada recurso acima pode ser ligado, desligado ou ajustado individualmente — incluindo qual aba de deck abre por padrão e o comportamento dos filtros da Compra por Lista. Também mostra quantas cartas tiveram o preço salvo hoje e as lojas já mapeadas.

---

## Funciona onde você já joga

| Site | Recursos |
|---|---|
| [LigaMagic](https://www.ligamagic.com.br) | Menu, deck view, compra por lista |
| [Archidekt](https://archidekt.com) | Overlay de preço |
| [Moxfield](https://moxfield.com) | Overlay de preço |
| [Scryfall](https://scryfall.com) | Overlay de preço |

---

## O que ainda não existe

Algumas ideias que ficaram de fora por enquanto — sem promessa de prazo, mas no radar:

- Suporte a outros sites de deckbuilding (TappedOut, Deckstats, EDHREC, MTGGoldfish...)
- Histórico/gráfico de variação de preço ao longo do tempo (hoje só mostra o valor mais recente salvo)
- Alertas de preço (avisar quando uma carta específica atingir um valor desejado)
- Comparação entre vendedores dentro do próprio LigaMagic (hoje o overlay mostra só o menor preço)
- Sincronização de preços/configurações entre navegadores ou dispositivos (hoje tudo é local a cada navegador)
- Suporte a Firefox ou outros navegadores além do Chrome/Chromium

---

## Instalação

1. Acesse `chrome://extensions` no Chrome
2. Ative o **Modo do desenvolvedor** (canto superior direito)
3. Clique em **Carregar sem compactação**
4. Selecione a pasta `chrome-extension/`

Pronto. A extensão já funciona na próxima vez que você abrir o LigaMagic ou um dos sites parceiros.

---

## Aviso legal

O **SAMV LigaMtg Enhancer** é uma ferramenta independente, feita sem fins lucrativos pela **Sociedade Amigos do Vale (SAMV)**, para a comunidade de jogadores. Não possui nenhum vínculo, parceria, patrocínio ou aprovação oficial de nenhuma das plataformas mencionadas:

- [LigaMagic](https://www.ligamagic.com.br)
- [Archidekt](https://archidekt.com)
- [Moxfield](https://moxfield.com)
- [Scryfall](https://scryfall.com)

**Como a extensão funciona por baixo dos panos.** Os preços em reais que aparecem no Archidekt, Moxfield e Scryfall são exatamente os valores que você já viu no LigaMagic — guardados no seu próprio navegador na primeira vez que você visita a carta por lá. A extensão só sobrepõe essa informação na tela, de forma puramente visual: nada é enviado de volta para o LigaMagic nem para qualquer outro lugar. Dentro do próprio LigaMagic, os ajustes de menu, visualização de deck e filtros de compra também rodam localmente, com a sua sessão já autenticada — nenhum comportamento por trás dessas telas é escondido de você.

O uso desta extensão é de responsabilidade de quem instala. E pra você não precisar confiar só na nossa palavra: o código é aberto e pode ser auditado por qualquer pessoa, a qualquer momento — é só olhar os arquivos em `chrome-extension/`.

Esta extensão **não contorna nenhuma medida de segurança, autenticação ou captcha** do LigaMagic ou de lojas parceiras — todas as requisições usam a sua própria sessão já autenticada, exatamente como o navegador já faria ao navegar normalmente pelo site.

Esta extensão **não contém links de afiliados** e **não gera nenhuma receita**. Os preços são exibidos exclusivamente como referência informativa — consulte sempre o LigaMagic para valores atualizados.

Magic: The Gathering é marca registrada da Wizards of the Coast LLC. "LigaMagic" é marca de titularidade da LigaMagic Portal de Compras LTDA. Esta extensão não é produzida, endossada ou afiliada a nenhuma das duas — o nome é citado apenas para identificar com qual site a extensão é compatível.

---

## Privacidade

Nenhum dado pessoal é coletado, transmitido a terceiros ou armazenado fora do seu navegador. Tudo — preços, configurações e histórico do dia — roda e fica salvo localmente em `chrome.storage.local`, no seu próprio navegador.

---

## Notas de publicação

- O popup já exibe a versão atual da extensão dinamicamente (via `chrome.runtime.getManifest().version`), então não precisa ser atualizada manualmente a cada release.
