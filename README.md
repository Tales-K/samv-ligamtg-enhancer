# SAMV LigaMtg Enhancer

**Preço em reais do LigaMagic nos sites onde você monta seus decks — e um LigaMagic mais rápido de usar.**

O **SAMV LigaMtg Enhancer** é uma extensão de navegador de **código aberto**, feita pela **Sociedade Amigos do Vale (SAMV)** para a comunidade de jogadores.

Ela faz duas coisas:

1. **Mostra o preço em R$ do LigaMagic direto no Archidekt, Moxfield e Scryfall** — você monta o deck onde já monta e vê, na mesma tela, quanto ele custa no Brasil.
2. **Melhora o próprio LigaMagic** — menu do seu jeito, deck ordenado por preço, filtros de compra prontos, cópia de listas em um clique e uma análise de quanto dá pra economizar na hora de fechar o carrinho.

Tudo é opcional: cada recurso abaixo pode ser ligado ou desligado no painel da extensão.

---

## Preço em R$ no Archidekt, Moxfield e Scryfall

- **Preço em reais no lugar do dólar.** No Archidekt e no Moxfield, o valor em USD ao lado de cada carta do deck é substituído pelo preço em R$ do LigaMagic. No Scryfall, aparece uma coluna **R$** na tabela de impressões — tanto nos resultados de busca quanto na página da carta.
- **Total do deck e de cada grupo em R$.** Criaturas, Feitiços, Terrenos e o deck inteiro recalculados em reais, sem calculadora.
- **"Carregar preços pendentes".** Um botão busca no LigaMagic o preço de todas as cartas do deck que ainda não têm valor em R$ — de uma vez, sem abrir carta por carta. No Scryfall também dá pra carregar o preço de uma carta específica.
- **Clique no preço e vá direto pro LigaMagic.** A carta certa, na página certa, pronta pra comparar vendedores ou comprar. Funciona até em cartas sem preço registrado. Pode ser desligado se você preferir o preço só como informação.
- **A cor mostra se o preço está fresco.** 🟢 menos de 7 dias · 🟡 entre 7 e 30 dias · 🔴 mais de 30 dias (consulte o LigaMagic).
- **No Scryfall, ainda:** botão **"Comprar no LigaMagic"** como primeira opção do painel "Buy This Card", botão **"Carregar Tags"** que traz as tags do Scryfall Tagger em uma tabela, e um botão que adiciona um filtro padrão seu (ex.: `sort:edhrec`) ao campo de busca.

---

## No LigaMagic

### Compra por Lista — onde o dinheiro é decidido
- **Análise de Economia.** Estima quanto você economizaria deixando de comprar cada carta cara, já considerando o frete das lojas envolvidas.
- **Filtros que já vêm prontos.** Idiomas, extras, qualidade e as opções de "ignorar sem estoque" / "ignorar pré-venda" aplicados automaticamente ao carregar a página. Se preferir, a extensão só lembra da sua última seleção manual — e há um botão **"Carregar filtro padrão"** pra aplicar sob demanda.
- **Busca em lojas customizadas.** Cole a URL de qualquer loja da Liga pra incluí-la na busca, sem mexer nos seus favoritos reais. As lojas ficam salvas numa lista própria, prontas pra marcar ou desmarcar depois.
- **Copiar Lista de Compras.** Um botão ao lado de "Finalizar Compra" copia as cartas que sobraram no resultado (já refletindo o que você removeu na tela), separadas por loja, em formato de lista de Magic. Opcionalmente com versão, qualidade, idioma e preço.

### Página do deck
- **Aba "Preço".** Ordena as cartas do deck por valor, sem misturar mainboard, sideboard e maybeboard. Dá pra escolher qual aba abre automaticamente em todo deck.
- **Botão "Copiar Deck".** A lista completa na área de transferência em um clique, em texto puro.
- **Remover o botão "Gerar Imagem"**, se você não usa.

### Menu e navegação
- Adicionar as abas **"Meus Decks"** e **"Meus Pedidos"** no menu principal.
- Remover as abas **"Leilões"** e **"Fórum"**.

### Prévia da carta (hover) e carrinho
- Ao passar o mouse sobre o nome de uma carta — no deck, em "Meus Decks" ou na página da carta — aparecem os botões **Scryfall**, **EDHREC** e **Copiar nome**, e o preço mostrado na prévia ganha um fundo claro que facilita a leitura.
- No carrinho, o botão **"Copiar Lista"** copia os itens no formato detalhado do LigaMagic (edição, qualidade, idioma, extras).

---

## Tudo no seu controle

O ícone da extensão abre um painel onde cada recurso acima é ligado, desligado ou ajustado individualmente — incluindo a aba padrão do deck, o comportamento dos filtros da Compra por Lista e o filtro padrão do Scryfall. O painel também mostra quantas cartas tiveram o preço salvo hoje, o total de atualizações e as lojas já conhecidas. (Clicando no número da versão, no rodapé, aparece uma opção de logs de diagnóstico usada durante o desenvolvimento.)

---

## Funciona onde você já joga

| Site | Recursos |
|---|---|
| [LigaMagic](https://www.ligamagic.com.br) | Menu, página de deck, prévia da carta, Compra por Lista, carrinho |
| [Archidekt](https://archidekt.com) | Preço em R$, totais do deck, preços pendentes |
| [Moxfield](https://moxfield.com) | Preço em R$, totais do deck, preços pendentes |
| [Scryfall](https://scryfall.com) | Coluna R$, preços pendentes, compra no LigaMagic, tags, filtro de busca |
| [EDHREC](https://edhrec.com) | Link direto pra página da carta no LigaMagic |

---

## Código aberto

O código é aberto e pode ser auditado por qualquer pessoa, a qualquer momento:
**https://github.com/Tales-K/samv-ligamtg-enhancer**

---

## Aviso legal

O **SAMV LigaMtg Enhancer** é uma ferramenta independente, feita sem fins lucrativos pela **Sociedade Amigos do Vale (SAMV)**, para a comunidade de jogadores. Não possui nenhum vínculo, parceria ou patrocínio de nenhuma das plataformas mencionadas: [LigaMagic](https://www.ligamagic.com.br), [Archidekt](https://archidekt.com), [Moxfield](https://moxfield.com), [Scryfall](https://scryfall.com) e [EDHREC](https://edhrec.com).

**Como a extensão funciona por baixo dos panos.** Os preços em reais que aparecem no Archidekt, Moxfield e Scryfall são exatamente os valores que você já viu no LigaMagic, guardados no seu próprio navegador na primeira vez que você visita a carta por lá — não existe uma base de preços compartilhada entre usuários. A extensão só sobrepõe essa informação na tela, de forma puramente visual: nada é enviado de volta para o LigaMagic nem para qualquer outro lugar. Dentro do próprio LigaMagic, os ajustes de menu, visualização de deck e filtros de compra também rodam localmente, com a sua sessão já autenticada: nenhum comportamento por trás dessas telas é escondido de você.

O uso desta extensão é de responsabilidade de quem instala.

Esta extensão **não contorna nenhuma medida de segurança, autenticação ou captcha** do LigaMagic ou de lojas parceiras: todas as requisições usam a sua própria sessão já autenticada, exatamente como o navegador já faria ao navegar normalmente pelo site.

Esta extensão **não contém links de afiliados** e **não gera nenhuma receita**. Os preços são exibidos exclusivamente como referência informativa. Consulte sempre o LigaMagic para valores atualizados.

Magic: The Gathering é marca registrada da Wizards of the Coast LLC. "LigaMagic" é marca de titularidade da LigaMagic Portal de Compras LTDA. Esta extensão não é produzida, endossada ou afiliada a nenhuma das duas. O nome é citado apenas para identificar com qual site a extensão é compatível.

---

## Privacidade

Nenhum dado pessoal é coletado, transmitido a terceiros ou armazenado fora do seu navegador. Tudo — preços, configurações e histórico do dia — roda e fica salvo localmente no seu próprio navegador.
