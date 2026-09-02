# Features — SAMV LigaMtg Enhancer

Lista completa de tudo que a extensão apresenta ao usuário, organizada por onde
cada recurso aparece. Só entram aqui recursos visíveis/interativos para quem
usa a extensão — nada de infraestrutura interna (scraping, cache, correções
silenciosas de bug) que não tem uma superfície própria na UI.

**Manutenção**: sempre que uma feature for adicionada, removida ou mudar de
comportamento/local, atualizar este arquivo no mesmo commit/sessão da
mudança de código — não deixar acumular divergência com o que a extensão
realmente faz.

**Cores dos preços**: em todo lugar que a extensão mostra um preço em BRL, a
cor indica há quanto tempo aquele valor foi atualizado — verde (menos de 7
dias), amarelo (7 a 30 dias) e vermelho (mais de 30 dias, ou sem preço
conhecido no LigaMagic). Exceção: nos dois lugares que mostram Mín/Méd/Máx
lado a lado (grid da página de deck e hover de carta, ambos no LigaMagic), as
mesmas três cores identificam qual dos três valores é qual — verde é sempre o
mínimo, amarelo o médio, vermelho o máximo — em vez de indicar idade.

---

## Qualquer site (menu de contexto do navegador)
- "Pesquisar carta" — ao selecionar um texto e clicar com o botão direito,
  abre um submenu com atalhos pra buscar esse texto no LigaMagic, Scryfall e
  EDHREC, cada um numa aba nova

---

## LigaMagic (ligamagic.com.br)

### Menu principal — qualquer página do site
- Adicionar aba "Meus Decks"
- Adicionar aba "Meus Pedidos"
- Remover aba "Leilões"
- Remover aba "Fórum"

### Página de deck — `?view=dks/deck&id=...`
- Aba "Preço" — lista os cards do deck ordenados por valor, sem misturar
  mainboard/sideboard/maybeboard
- Botão "Copiar Deck" — copia a lista de cards para a área de transferência
- Remover botão nativo "Gerar Imagem" (independente do botão acima — os dois
  podem ficar visíveis ao mesmo tempo)
- Definir qual aba abre automaticamente ao entrar na página do deck
- Preços Mín/Méd/Máx embaixo de cada carta na aba nativa "Grid", lado a lado
  numa linha só, coloridos por identidade (verde/amarelo/vermelho, ver nota
  acima) em vez de rotulados por texto (habilitado por padrão)

### Hover de carta (tooltip ao passar o mouse sobre o nome ou a imagem de
uma carta) — deck, listagem de "Meus Decks", grade de busca de cartas
(`?view=cards/search` e outras páginas com a mesma grade, ex.: Compra por
Lista), e qualquer outro lugar do site que use o mesmo tooltip; também na
página individual da carta
- Botões "Scryfall", "EDHREC" e "Copiar nome" na caixa do hover — não
  desaparece ao mover o mouse em direção aos botões
- Preço Mín/Méd/Máx (quando disponível) na caixa do hover, lado a lado numa
  linha só, coloridos por identidade (ver nota sobre cores no topo do
  arquivo) — fundo esbranquiçado atrás do texto para facilitar a leitura

### Página individual da carta — `?view=cards/card&card=...`
- Lupa roxa ao passar o mouse sobre uma versão na lista de versões — clicar
  nela filtra a lista "Lojas Vendendo" da aba "Comprar no Marketplace" (mais
  abaixo, na mesma página) por aquela edição

### Compra por Lista — `?view=cards/lista`
- Aplicar filtros padrão automaticamente ao carregar a página (idiomas,
  extras, qualidade, ignorar sem estoque/pré-venda)
- Usar os últimos valores selecionados manualmente em vez dos padrões
  configurados
- Botão "Carregar filtro padrão" — aplica os valores configurados sob demanda
- Busca em lojas customizadas — campo para colar a URL de uma loja e incluí-la
  na busca sem mexer nos favoritos reais
- Botão "Copiar Lista de Compras" — copia os cards ainda na lista, por loja,
  em formato de lista de Magic (com opções: incluir versão, qualidade, idioma
  e preço de cada carta)
- Botão "Análise de Economia" — estima quanto se economizaria deixando de
  comprar cada carta cara, considerando o frete das lojas envolvidas

### Carrinho — `?view=mp/carrinho`
- Botão "Copiar Lista" — copia os cards do carrinho no formato detalhado do
  LigaMagic (edição, qualidade, idioma, extras)

---

## Archidekt (archidekt.com)
- Overlay de preço — substitui o preço em USD por preço em BRL do LigaMagic,
  ao lado de cada carta na página de deck
- Preço do LigaMagic na janela de detalhes da carta — ao lado dos preços das
  lojas que o próprio Archidekt já mostra ali
- Preço do LigaMagic em cada carta da visão em grade ("View as" → Grid)
- Total do deck e de cada grupo (Criaturas, Feitiços, Terrenos...) recalculado
  em BRL, tanto na visão de texto quanto na visão em grade
- Botão "Carregar preços pendentes" — busca no LigaMagic o preço de toda carta
  que ainda não tem um valor em BRL
- Clique no preço abre a página da carta no LigaMagic (opcional)
- Cartas da seção "Tokens & Extras" do deck (tokens, emblemas etc. que o
  próprio Archidekt gera e que não fazem parte do deck de fato) ficam de fora
  de tudo isso — não entram no contador de preços pendentes, no total do
  deck/grupo, nem são enviadas ao LigaMagic

## Moxfield (moxfield.com)
- Overlay de preço — substitui o preço em USD por preço em BRL do LigaMagic,
  ao lado de cada carta na página de deck
- Preço em BRL embaixo de cada carta na visão "Visual Spoiler"
- Link "Comprar no LigaMagic" — primeiro item da lista de lojas do popup de
  preview que aparece ao passar o mouse sobre uma carta, com o preço em BRL do
  lado igual as lojas nativas; acompanha a carta que o popup estiver mostrando
  no momento. Mesmo link também no modal que abre ao clicar numa carta
- Total do deck e de cada grupo recalculado em BRL, tanto nas visões de texto
  quanto nas de imagem (Visual Grid e Visual Spoiler)
- Botão "Carregar preços pendentes" — busca no LigaMagic o preço de toda carta
  que ainda não tem um valor em BRL
- Clique no preço abre a página da carta no LigaMagic (opcional)

## Scryfall (scryfall.com)
- Ícone de busca dentro do campo de pesquisa do cabeçalho — clicar nele
  dispara a mesma busca que apertar Enter já dispara
- Overlay de preço — coluna "R$" na tabela de impressões, em resultados de
  busca (`as=full`) e na página individual da carta
- Selo de preço em BRL sobre cada carta nos resultados de busca em grade
  (`as=grid`), colorido pela idade do preço (ver nota sobre cores no topo do
  arquivo)
- Botão "Carregar preços pendentes" — busca no LigaMagic o preço de toda carta
  que ainda não tem um valor em BRL
- Botão "Comprar no LigaMagic" — primeiro item no painel nativo "Buy This
  Card" da página individual da carta
- Clique no preço abre a página da carta no LigaMagic (opcional)
- Botão "Carregar Tags" — busca as tags do Scryfall Tagger e mostra numa
  tabela, na caixa de impressões da carta
- Botão "Carregar Preço" — carrega sob demanda o preço de um card específico
  que ainda não tem a coluna "R$"
- Botão "Filtro padrão" — acrescenta um filtro configurável (ex.:
  `sort:edhrec`) ao campo de busca do header, sem submeter
- Botão de engrenagem ao lado dele — abre um painel flutuante para definir o
  filtro padrão sem sair do Scryfall. O valor é o mesmo campo "Filtro padrão"
  do popup da extensão, então pode ser editado pelos dois lugares

## EDHREC (edhrec.com)
- Link "Ver no LigaMagic" na página de um comandante — abre a página da
  carta no LigaMagic em uma nova aba

---

## Popup da extensão (não é uma página do LigaMagic)
- Painel de configurações — liga/desliga e ajusta individualmente cada
  recurso listado acima
- Checkbox oculta "logs" — só aparece ao clicar no número da versão, no
  rodapé; ativa logs de diagnóstico usados durante o desenvolvimento
- Estatísticas do "Rastreador de Preços" (cards salvos hoje, total de
  atualizações) e lista de lojas já mapeadas
- Modal de disclaimer na primeira abertura (hobby/não afiliação com o
  LigaMagic)
