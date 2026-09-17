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
- Preço ao lado de cada carta no modal "Comprar Deck", com as cartas
  ordenadas da mais barata à mais cara e divididas por faixa de valor dentro
  de cada grupo (Maindeck/Sideboard), sem misturar os grupos entre si

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
- Segunda linha no botão "Pesquisar" do formulário de cartas e filtros,
  dizendo o alcance da busca conforme o "Tipo de Busca" selecionado:
  "Todas as Lojas" ou "Favoritas + Buscadas"
- Busca em lojas customizadas — campo para colar o nome, a URL ou o ID de uma
  loja e incluí-la na busca sem mexer nos favoritos reais
- Botão "Copiar Lista de Compras" — copia os cards ainda na lista, por loja,
  em formato de lista de Magic (com opções: incluir versão, qualidade, idioma
  e preço de cada carta); o comentário de cada loja também traz o ID dela e,
  quando já resolvido, o site
- Botão "Análise de Economia" — abre uma modal com, de cima pra baixo: o
  cabeçalho, o status da Super Pesquisa (ver abaixo), os dois botões de
  ação e três abas de sugestões:
  - "Reorganização entre lojas" — comprar as mesmas cartas em outra loja já
    usada, sem remover nenhuma, pra fechar uma ou mais lojas inteiras e
    economizar o frete delas; quando fechar duas de uma vez rende mais do
    que fechar qualquer uma sozinha, essa combinação aparece no topo da lista
  - "Remoção de cartas" — deixar de comprar uma carta cara, considerando o
    frete das lojas envolvidas
  - "Fretes acima da média" — lojas cujo frete sozinho já está acima do valor
    configurado no painel
  Cada aba mostra quantas sugestões tem, e a modal já abre na primeira que
  tiver alguma
- A análise se refaz sozinha sempre que a lista de compras muda — alterar a
  quantidade de uma carta, remover uma carta ou remover uma loja inteira
  atualiza tanto a legenda embaixo do botão quanto a modal, se ela estiver
  aberta (a aba que você escolheu continua aberta). Não é preciso pedir
  recálculo; a modal também nunca aparece sozinha por causa de uma mudança
  na lista — só quando você abre
- Legenda embaixo do botão "Análise de Economia" — assim que o frete de
  todas as lojas termina de calcular, mostra automaticamente quanto dá pra
  economizar por reorganização (nenhuma carta é removida), sem precisar
  abrir a modal primeiro
- Botão "Aplicar Economia" em cada item das abas "Reorganização entre lojas"
  e "Remoção de cartas" — ajusta as quantidades
  de cada carta nas lojas certas pra realizar aquela sugestão específica na
  tela de resultados, e recalcula a análise em seguida (uma sugestão
  aplicada pode mudar as outras disponíveis)
- Dois botões logo abaixo do cabeçalho da modal: "Economizar nessa compra" —
  sempre visível, com o quanto dá pra economizar escrito embaixo (ou
  desabilitado, com "economia máxima já alcançada nessa lista", quando não
  sobra nada) — fecha de uma vez o conjunto de lojas que rende a maior
  economia possível; e "Super Pesquisa" (ver abaixo)
- Super Pesquisa — abre uma segunda aba em segundo plano (sem tirar o foco
  da aba atual) e refaz a mesma lista de compras numa pesquisa mais ampla
  (misturando cartas de decks públicos aleatórios só de preenchimento, até
  uma quantidade alvo, pra forçar o site a considerar mais lojas — nunca
  comprados). Dessa pesquisa sai o preço e o estoque de cada carta em cada
  loja encontrada; a partir desse mapa a extensão calcula em quais lojas
  vale a pena comprar, contando o frete de cada uma, e só então faz a
  segunda busca — só com as cartas reais — restrita às lojas desse plano.
  Tudo isso na tentativa de achar um total menor do que essa página sozinha
  encontraria, já com toda economia por reorganização aplicada no
  resultado. Detecta sozinho se a lista original
  usava versões exatas por carta ou só o filtro geral. Enquanto roda, a
  modal "Análise de Economia" mostra em que etapa está ("Etapa 3 de 6:
  pesquisa de descoberta, sem restringir lojas") com uma barra de
  progresso. Ao concluir, mostra ali mesmo as lojas encontradas, o valor
  total e a economia, perguntando "Gostaria de fazer essa mudança?" com três
  opções: **Sim** (refaz a busca na própria aba de origem, restrita a essas
  lojas), **Não** (descarta o resultado) e **Sim, numa nova aba** (foca a
  segunda aba, que já está com a busca e a reorganização prontas). O
  resultado fica guardado enquanto a página não recarrega, então fechar e
  reabrir a modal traz ele de volta. Se o
  melhor valor encontrado não for menor que o atual, mostra apenas que não
  achou economia, sem os três botões
- Alerta de frete caro — destaca em vermelho o frete de uma loja acima do
  valor configurado no painel (padrão R$ 35) e mostra um aviso temporário
  sugerindo bloquear a loja e pesquisar de novo
- Coluna "Preço Mínimo" (entre "Comprar" e "R$ Unit." na tabela de cada
  loja) — mostra, um em cima do outro, o menor preço que esta extensão já
  registrou pra essa carta em qualquer loja do LigaMagic (dado local,
  atualizado sempre que você vê o preço dela em algum lugar — o mesmo cache
  usado pelo preço em R$ no Archidekt/Moxfield/Scryfall) e o quanto o preço
  desta oferta está acima desse mínimo, em R$ e %; um traço quando esse valor
  ainda não foi registrado. Passar o mouse e
  segurar mostra uma explicação. Um botão "Carregar valores mínimos"
  aparece entre "Análise de Economia" e "Copiar Lista de Compras" sempre
  que alguma carta da lista ainda não tiver esse valor salvo, buscando-o em
  lote (mesmo mecanismo de "Carregar preços pendentes"). O "Sumário Geral"
  também ganha, logo abaixo de "X Itens", o total de preços mínimos e a
  diferença para o total atual (considerando as quantidades compradas de
  cada carta), em roxo

### Carrinho — `?view=mp/carrinho`
- Botão "Copiar Lista" — copia os cards do carrinho no formato detalhado do
  LigaMagic (edição, qualidade, idioma, extras); o comentário de cada loja
  também traz o ID dela e, quando já resolvido, o site

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
- Ícone de busca (lupa roxa, lado esquerdo do campo de pesquisa do
  cabeçalho) — é um link de verdade: clique simples dispara a mesma busca
  que apertar Enter já dispara, e ctrl+clique ou clique do meio abre a busca
  numa aba nova
- 5 pipetas de identidade de cor (W/U/B/R/G) à direita do campo de pesquisa
  do cabeçalho — clicar numa alterna (adiciona/remove) o termo `ci:<cor>` na
  busca; acende quando o termo correspondente já está no campo (clicado ou
  digitado à mão)
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
- Botão "Ver no LigaMagic" na página de um comandante — abre a página da
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
