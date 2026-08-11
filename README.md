# SAMV LigaMtg Enhancer

**Uma experiência melhor no LigaMagic e nos sites que você já usa para montar seus decks.**

O **SAMV LigaMtg Enhancer** é uma extensão de navegador feita pela **Sociedade Amigos do Vale (SAMV)**  deixa o próprio LigaMagic mais rápido de usar: menu enxuto, deck ordenado por preço, filtros de compra que já vêm do jeito que você quer e uma forma de copiar cartas da "Compra por Lista", e de quebra ainda mostra o preço em reais do LigaMagic direto no Archidekt, Moxfield e Scryfall.

---

## O que isso resolve

- Você pode montar decks nos seus sites favoritos e ver o preço deles no Liga;
- Você ganha um atalho para visualizar as cartas no Liga;
- Melhora a experiência geral por todo o site do LigaMagic, Scryfall, Archidekt e Moxfield, com recursos que não existem nativamente.

---

## No LigaMagic

### Menu principal sob medida
Adiciona uma aba **"Meus Decks"** direto no menu principal (atalho para seus decks salvos) e remove a aba **"Leilões"**, se você não usa. Ambos configuráveis: pode desligar qualquer um dos dois.

### Visualização de deck por Preço
Uma nova aba **"Preço"** na página do deck, ao lado de Padrão/Cor/Custo/etc., que ordena as cartas por valor sem misturar mainboard, sideboard e maybeboard. Dá pra definir qual aba abre automaticamente ao entrar em qualquer deck.

### Copiar Deck em vez de Gerar Imagem
O botão "Gerar Imagem" da página do deck vira **"Copiar Deck"**: um clique copia a lista completa (mainboard + sideboard) para a área de transferência em formato de texto puro (`<quantidade> <nome>`), pronta para colar onde precisar.

### Filtros automáticos na Compra por Lista
Na página "Compra por Lista", configure de uma vez os valores padrão de Idiomas, Extras, Qualidade e as opções de "ignorar sem estoque" / "ignorar pré-venda", aplicados automaticamente toda vez que a página carrega. Também dá pra deixar o plugin apenas lembrar da última seleção manual que você fez, sem precisar fixar valores fixos.

### Busca em lojas customizadas
Na mesma página, cole a URL de qualquer loja da Liga pra incluí-la na busca, sem precisar favoritá-la de verdade nem mexer nos seus favoritos reais. As lojas ficam guardadas numa lista própria, prontas pra marcar ou desmarcar na próxima busca.

### Copiar Lista de Compras
Depois de pesquisar, um botão ao lado de "Finalizar Compra" copia todas as cartas que sobraram no resultado (já refletindo qualquer carta ou loja que você removeu na tela) em formato de lista de Magic, separadas por loja. Por padrão copia só quantidade e nome em inglês; dá pra incluir versão, qualidade, idioma e preço de cada carta, e a extensão lembra da sua última escolha.

---

## Nos sites parceiros (Archidekt, Moxfield, Scryfall)

### Preço em R$ ao lado de cada carta
O preço mínimo em reais aparece diretamente na listagem do seu deck, sem precisar sair da página ou abrir nenhuma outra aba. O preço é salvo no seu navegador na primeira vez que você visita a carta no LigaMagic: não existe uma base de preços compartilhada entre usuários.

### Link direto para o LigaMagic em cada carta (opcional)
Clicou no preço? Você já está na página certa no LigaMagic para comprar, comparar vendedores ou verificar o histórico. Funciona até para cartas sem preço cadastrado: elas também viram link. Esse comportamento pode ser desligado nas configurações, se você preferir que o preço seja só informativo.

### Saiba se o preço está fresco ou defasado
A cor do preço indica há quanto tempo ele foi registrado:
- **Verde**: menos de 7 dias. Pode confiar.
- **Amarelo**: entre 7 e 30 dias. Vale checar.
- **Vermelho**: mais de 30 dias. Consulte o LigaMagic diretamente.

### Total do deck e por grupo em BRL
Veja o custo estimado do deck inteiro em reais, e o subtotal de cada seção (Criaturas, Feitiços, Terrenos...), sem precisar calcular nada na mão.

---

## Tudo configurável

O ícone da extensão abre um painel onde cada recurso acima pode ser ligado, desligado ou ajustado individualmente, incluindo qual aba de deck abre por padrão e o comportamento dos filtros da Compra por Lista. Também mostra quantas cartas tiveram o preço salvo hoje e as lojas já mapeadas.

---

## Funciona onde você já joga

| Site | Recursos |
|---|---|
| [LigaMagic](https://www.ligamagic.com.br) | Menu, deck view, compra por lista |
| [Archidekt](https://archidekt.com) | Overlay de preço |
| [Moxfield](https://moxfield.com) | Overlay de preço |
| [Scryfall](https://scryfall.com) | Overlay de preço e exibição de oracle-tags |

---

## Aviso legal

O **SAMV LigaMtg Enhancer** é uma ferramenta independente, feita sem fins lucrativos pela **Sociedade Amigos do Vale (SAMV)**, para a comunidade de jogadores. Não possui nenhum vínculo, parceria ou patrocínio de nenhuma das plataformas mencionadas:

- [LigaMagic](https://www.ligamagic.com.br)
- [Archidekt](https://archidekt.com)
- [Moxfield](https://moxfield.com)
- [Scryfall](https://scryfall.com)

**Como a extensão funciona por baixo dos panos.** Os preços em reais que aparecem no Archidekt, Moxfield e Scryfall são exatamente os valores que você já viu no LigaMagic, guardados no seu próprio navegador na primeira vez que você visita a carta por lá. A extensão só sobrepõe essa informação na tela, de forma puramente visual: nada é enviado de volta para o LigaMagic nem para qualquer outro lugar. Dentro do próprio LigaMagic, os ajustes de menu, visualização de deck e filtros de compra também rodam localmente, com a sua sessão já autenticada: nenhum comportamento por trás dessas telas é escondido de você.

O uso desta extensão é de responsabilidade de quem instala. O código é aberto e pode ser auditado por qualquer pessoa, a qualquer momento: `https://github.com/Tales-K/samv-ligamtg-enhancer`.

Esta extensão **não contorna nenhuma medida de segurança, autenticação ou captcha** do LigaMagic ou de lojas parceiras: todas as requisições usam a sua própria sessão já autenticada, exatamente como o navegador já faria ao navegar normalmente pelo site.

Esta extensão **não contém links de afiliados** e **não gera nenhuma receita**. Os preços são exibidos exclusivamente como referência informativa. Consulte sempre o LigaMagic para valores atualizados.

Magic: The Gathering é marca registrada da Wizards of the Coast LLC. "LigaMagic" é marca de titularidade da LigaMagic Portal de Compras LTDA. Esta extensão não é produzida, endossada ou afiliada a nenhuma das duas. O nome é citado apenas para identificar com qual site a extensão é compatível.

---

## Privacidade

Nenhum dado pessoal é coletado, transmitido a terceiros ou armazenado fora do seu navegador. Tudo (preços, configurações e histórico do dia) roda e fica salvo localmente no seu próprio navegador.
