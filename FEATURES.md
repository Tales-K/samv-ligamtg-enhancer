# Features — SAMV LigaMtg Enhancer

Lista completa de tudo que a extensão apresenta ao usuário, organizada por onde
cada recurso aparece. Só entram aqui recursos visíveis/interativos para quem
usa a extensão — nada de infraestrutura interna (scraping, cache, correções
silenciosas de bug) que não tem uma superfície própria na UI.

**Manutenção**: sempre que uma feature for adicionada, removida ou mudar de
comportamento/local, atualizar este arquivo no mesmo commit/sessão da
mudança de código — não deixar acumular divergência com o que a extensão
realmente faz.

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

### Hover de carta (tooltip ao passar o mouse sobre o nome de uma carta) —
deck, listagem de "Meus Decks", e qualquer outro lugar do site que use o
mesmo tooltip; também na página individual da carta
- Botões "Scryfall", "EDHREC" e "Copiar nome" acima da imagem do hover
- Fundo esbranquiçado atrás do texto de preço mostrado no hover, na view de
  deck, para facilitar a leitura

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
- Total do deck e de cada grupo (Criaturas, Feitiços, Terrenos...) recalculado
  em BRL
- Botão "Carregar preços pendentes" — busca no LigaMagic o preço de toda carta
  que ainda não tem um valor em BRL
- Clique no preço abre a página da carta no LigaMagic (opcional)

## Moxfield (moxfield.com)
- Overlay de preço — substitui o preço em USD por preço em BRL do LigaMagic,
  ao lado de cada carta na página de deck
- Total do deck e de cada grupo recalculado em BRL
- Botão "Carregar preços pendentes" — busca no LigaMagic o preço de toda carta
  que ainda não tem um valor em BRL
- Clique no preço abre a página da carta no LigaMagic (opcional)

## Scryfall (scryfall.com)
- Overlay de preço — coluna "R$" na tabela de impressões, em resultados de
  busca (`as=full`) e na página individual da carta
- Botão "Carregar preços pendentes" — busca no LigaMagic o preço de toda carta
  que ainda não tem um valor em BRL
- Botão "Comprar no LigaMagic" — primeiro item no painel nativo "Buy This
  Card" da página individual da carta
- Clique no preço abre a página da carta no LigaMagic (opcional)
- Botão "Carregar Tags" — busca as tags do Scryfall Tagger e mostra numa
  tabela, na caixa de impressões da carta
- Botão "Carregar Preço" — carrega sob demanda o preço de um card específico
  que ainda não tem a coluna "R$"
- Botão de filtro padrão — acrescenta um filtro configurável (ex.:
  `sort:edhrec`) ao campo de busca do header, sem submeter

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
