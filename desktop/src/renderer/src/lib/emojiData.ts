// Curated emoji set for the picker (offline, no dependency). One line per emoji: `emoji|name|keywords`.
// A `+` right after the emoji marks one that takes a skin tone. Text-default symbols (❤ ☀ ✌ …) get their
// emoji variation selector added by lib/emoji.ts, and anything that fails EMOJI_RE is dropped there.
// Plain data (its only import, msg, is from the import-free i18n/core), so desktop/scripts/check-emoji.mjs can load
// it under bare Node. Category labels are message keys: shown with t(label). Emoji names and keywords stay English.
import { msg } from '../i18n/core'

export interface EmojiCategoryData {
  id: string
  label: string
  /** Shown on the category tab. */
  icon: string
  list: string
}

export const EMOJI_DATA: EmojiCategoryData[] = [
  {
    id: 'smileys',
    label: msg('Smileys & Emotion'),
    icon: '😀',
    list: `
😀|grinning face|smile happy
😃|grinning face with big eyes|smile happy joy
😄|grinning face with smiling eyes|smile happy laugh
😁|beaming face|grin smile teeth
😆|grinning squinting face|laugh lol satisfied
😅|grinning face with sweat|relief nervous
🤣|rolling on the floor laughing|rofl lol lmao
😂|face with tears of joy|lol laugh cry haha
🙂|slightly smiling face|smile
🙃|upside-down face|silly sarcasm
🫠|melting face|hot dissolve embarrassed
😉|winking face|wink flirt
😊|smiling face with smiling eyes|blush happy
😇|smiling face with halo|angel innocent
🥰|smiling face with hearts|love adore crush
😍|heart eyes|love crush
🤩|star-struck|wow amazing excited
😘|face blowing a kiss|kiss love
😗|kissing face|kiss
☺|smiling face|relaxed happy
😚|kissing face with closed eyes|kiss
😙|kissing face with smiling eyes|kiss
🥲|smiling face with tear|grateful touched
😋|face savoring food|yum delicious tongue
😛|face with tongue|tongue playful
😜|winking face with tongue|crazy playful
🤪|zany face|crazy goofy wild
😝|squinting face with tongue|tongue
🤑|money-mouth face|rich money dollar
🤗|hugging face|hug thanks
🤭|face with hand over mouth|oops giggle
🫢|face with open eyes and hand over mouth|gasp shock
🤫|shushing face|quiet secret shh
🤔|thinking face|think hmm wonder
🫡|saluting face|salute respect ok
🤐|zipper-mouth face|secret quiet
🤨|face with raised eyebrow|suspicious skeptical
😐|neutral face|meh
😑|expressionless face|blank meh
😶|face without mouth|silent speechless
🫥|dotted line face|invisible hidden
😏|smirking face|smirk smug
😒|unamused face|meh annoyed
🙄|face with rolling eyes|eyeroll whatever
😬|grimacing face|awkward yikes
😮‍💨|face exhaling|sigh relief
🤥|lying face|liar pinocchio
😌|relieved face|calm relief
😔|pensive face|sad thoughtful
😪|sleepy face|tired
🤤|drooling face|drool
😴|sleeping face|sleep zzz tired
😷|face with medical mask|sick mask
🤒|face with thermometer|sick ill fever
🤕|face with head-bandage|hurt injured
🤢|nauseated face|sick gross
🤮|face vomiting|sick puke gross
🤧|sneezing face|sick sneeze
🥵|hot face|heat sweating
🥶|cold face|freezing cold
🥴|woozy face|dizzy drunk
😵|face with crossed-out eyes|dizzy dead
😵‍💫|face with spiral eyes|dizzy hypnotized
🤯|exploding head|mind blown shocked
🤠|cowboy hat face|cowboy yeehaw
🥳|partying face|party celebrate birthday
🥸|disguised face|disguise incognito
😎|smiling face with sunglasses|cool sunglasses
🤓|nerd face|nerd geek
🧐|face with monocle|curious inspect
😕|confused face|confused unsure
🫤|face with diagonal mouth|unsure meh
😟|worried face|worried concern
🙁|slightly frowning face|sad frown
☹|frowning face|sad
😮|face with open mouth|wow surprised
😯|hushed face|surprised
😲|astonished face|shocked amazed
😳|flushed face|embarrassed blush
🥺|pleading face|puppy eyes please
🥹|face holding back tears|touched grateful
😦|frowning face with open mouth|shocked
😧|anguished face|anguish
😨|fearful face|scared afraid
😰|anxious face with sweat|nervous anxious
😥|sad but relieved face|phew
😢|crying face|sad tear cry
😭|loudly crying face|sob cry sad
😱|face screaming in fear|scream scared horror
😖|confounded face|frustrated
😣|persevering face|struggle
😞|disappointed face|sad disappointed
😓|downcast face with sweat|sweat
😩|weary face|tired frustrated
😫|tired face|exhausted
🥱|yawning face|bored tired yawn
😤|face with steam from nose|triumph angry huff
😡|enraged face|angry mad rage
😠|angry face|mad annoyed
🤬|face with symbols on mouth|swearing cursing
😈|smiling face with horns|devil evil
👿|angry face with horns|devil imp
💀|skull|dead lol dying
☠|skull and crossbones|danger poison death
💩|pile of poo|poop
🤡|clown face|clown
👹|ogre|monster
👺|goblin|monster
👻|ghost|halloween boo
👽|alien|ufo extraterrestrial
👾|alien monster|game space invader
🤖|robot|bot machine
😺|grinning cat|cat smile
😹|cat with tears of joy|cat lol
😻|smiling cat with heart-eyes|cat love
😼|cat with wry smile|cat smirk
🙀|weary cat|cat shocked
😿|crying cat|cat sad
🙈|see-no-evil monkey|monkey shy oops
🙉|hear-no-evil monkey|monkey
🙊|speak-no-evil monkey|monkey secret
💋|kiss mark|kiss lips
💌|love letter|mail love
💘|heart with arrow|love cupid
💝|heart with ribbon|gift love
💖|sparkling heart|love
💗|growing heart|love
💓|beating heart|love
💞|revolving hearts|love
💕|two hearts|love
💟|heart decoration|love
❣|heart exclamation|love
💔|broken heart|sad heartbreak
❤️‍🔥|heart on fire|love passion
❤️‍🩹|mending heart|healing recovery
❤|red heart|love like
🩷|pink heart|love
🧡|orange heart|love
💛|yellow heart|love
💚|green heart|love
💙|blue heart|love
🩵|light blue heart|love
💜|purple heart|love
🤎|brown heart|love
🖤|black heart|love
🩶|grey heart|love
🤍|white heart|love
💯|hundred points|100 perfect score
💢|anger symbol|angry
💥|collision|boom explosion
💫|dizzy|star
💦|sweat droplets|water splash
💨|dashing away|wind fast
🕳|hole|
💬|speech balloon|chat message comment
👁️‍🗨️|eye in speech bubble|witness
🗨|left speech bubble|chat
🗯|right anger bubble|angry
💭|thought balloon|think
💤|zzz|sleep tired
`,
  },
  {
    id: 'people',
    label: msg('People & Body'),
    icon: '👋',
    list: `
👋+|waving hand|hello hi bye wave
🤚+|raised back of hand|stop
🖐+|hand with fingers splayed|hand five
✋+|raised hand|stop high five
🖖+|vulcan salute|spock star trek
🫱+|rightwards hand|
🫲+|leftwards hand|
🫳+|palm down hand|
🫴+|palm up hand|
👌+|ok hand|ok okay perfect
🤌+|pinched fingers|italian what
🤏+|pinching hand|small tiny little
✌+|victory hand|peace two
🤞+|crossed fingers|luck hope
🫰+|hand with index finger and thumb crossed|money love snap
🤟+|love-you gesture|love you
🤘+|sign of the horns|rock metal
🤙+|call me hand|call shaka
👈+|backhand index pointing left|left point
👉+|backhand index pointing right|right point
👆+|backhand index pointing up|up point
🖕+|middle finger|rude
👇+|backhand index pointing down|down point
☝+|index pointing up|up point one
🫵+|index pointing at the viewer|you point
👍+|thumbs up|like yes approve +1 good
👎+|thumbs down|dislike no -1 bad
✊+|raised fist|fist power
👊+|oncoming fist|punch fist bump
🤛+|left-facing fist|fist bump
🤜+|right-facing fist|fist bump
👏+|clapping hands|clap applause bravo
🙌+|raising hands|hooray celebrate yay
🫶+|heart hands|love
👐+|open hands|hug
🤲+|palms up together|pray
🤝+|handshake|deal agreement
🙏+|folded hands|please thanks pray
✍+|writing hand|write
💅+|nail polish|nails beauty
🤳+|selfie|camera phone
💪+|flexed biceps|strong muscle gym
🦾|mechanical arm|robot prosthetic
🦵+|leg|kick
🦶+|foot|kick stomp
👂+|ear|hear listen
🦻+|ear with hearing aid|
👃+|nose|smell
🧠|brain|smart think
🫀|anatomical heart|organ
🫁|lungs|breath
🦷|tooth|teeth dentist
🦴|bone|skeleton
👀|eyes|look see watching
👁|eye|look see
👅|tongue|lick
👄|mouth|lips
🫦|biting lip|nervous flirt
👶+|baby|child newborn
🧒+|child|kid
👦+|boy|kid
👧+|girl|kid
🧑+|person|adult
👱+|person with blond hair|blond
👨+|man|guy
🧔+|person with beard|beard
👩+|woman|lady
🧓+|older person|old elder
👴+|old man|elder grandpa
👵+|old woman|elder grandma
🙍+|person frowning|sad
🙎+|person pouting|pout
🙅+|person gesturing no|no nope
🙆+|person gesturing ok|ok yes
💁+|person tipping hand|info sassy
🙋+|person raising hand|hand question me
🧏+|deaf person|
🙇+|person bowing|bow sorry thanks
🤦+|person facepalming|facepalm ugh
🤷+|person shrugging|shrug whatever idk
🧑‍💻+|technologist|developer coder programmer computer
🧑‍🎓+|student|graduate school
🧑‍🏫+|teacher|professor
🧑‍🍳+|cook|chef
🧑‍🔧+|mechanic|repair
🧑‍🔬+|scientist|lab
🧑‍🎨+|artist|painter
🧑‍🚀+|astronaut|space
🧑‍🚒+|firefighter|fire
👮+|police officer|cop
🕵+|detective|spy sleuth
💂+|guard|
🥷+|ninja|stealth
👷+|construction worker|builder
🤴+|prince|royal
👸+|princess|royal
🤵+|person in tuxedo|formal
👰+|person with veil|wedding bride
🤰+|pregnant woman|
🎅+|santa claus|christmas
🤶+|mrs claus|christmas
🦸+|superhero|hero
🦹+|supervillain|villain
🧙+|mage|wizard witch magic
🧚+|fairy|magic
🧛+|vampire|dracula
🧜+|merperson|mermaid
🧝+|elf|fantasy
🧞|genie|wish
🧟|zombie|undead
💆+|person getting massage|relax spa
💇+|person getting haircut|hair
🚶+|person walking|walk
🧍+|person standing|stand
🧎+|person kneeling|kneel
🏃+|person running|run fast
💃+|woman dancing|dance party
🕺+|man dancing|dance party
🕴+|person in suit levitating|
👯|people with bunny ears|dance party
🧖+|person in steamy room|sauna
🧗+|person climbing|climb
🏇+|horse racing|
⛷|skier|ski snow
🏂+|snowboarder|snow
🏌+|person golfing|golf
🏄+|person surfing|surf
🚣+|person rowing boat|row
🏊+|person swimming|swim
🤽+|person playing water polo|
🚴+|person biking|bike cycling
🤸+|person cartwheeling|gymnastics
🤼|people wrestling|wrestle
🤹+|person juggling|juggle
🧘+|person in lotus position|yoga meditate zen
🛀+|person taking bath|bath
🛌+|person in bed|sleep
🧑‍🤝‍🧑|people holding hands|friends
👭|women holding hands|friends
👫|woman and man holding hands|couple
👬|men holding hands|couple
💏|kiss|couple love
💑|couple with heart|love
👪|family|
🗣|speaking head|talk speak
👤|bust in silhouette|user person
👥|busts in silhouette|users people group
🫂|people hugging|hug comfort
👣|footprints|steps
`,
  },
  {
    id: 'nature',
    label: msg('Animals & Nature'),
    icon: '🐶',
    list: `
🐶|dog face|puppy pet
🐱|cat face|kitten pet
🐭|mouse face|
🐹|hamster|pet
🐰|rabbit face|bunny
🦊|fox|
🐻|bear|
🐼|panda|
🐻‍❄️|polar bear|
🐨|koala|
🐯|tiger face|
🦁|lion|
🐮|cow face|
🐷|pig face|
🐸|frog|
🐵|monkey face|
🐔|chicken|
🐧|penguin|
🐦|bird|
🐤|baby chick|
🦆|duck|
🦅|eagle|
🦉|owl|
🦇|bat|
🐺|wolf|
🐗|boar|
🐴|horse face|
🦄|unicorn|magic
🐝|honeybee|bee
🪱|worm|
🐛|bug|caterpillar
🦋|butterfly|
🐌|snail|slow
🐞|lady beetle|ladybug
🐜|ant|
🪲|beetle|bug
🕷|spider|
🦂|scorpion|
🐢|turtle|slow
🐍|snake|
🦎|lizard|
🦖|t-rex|dinosaur
🦕|sauropod|dinosaur
🐙|octopus|
🦑|squid|
🦐|shrimp|
🦀|crab|
🐡|blowfish|
🐠|tropical fish|
🐟|fish|
🐬|dolphin|
🐳|spouting whale|
🐋|whale|
🦈|shark|
🐊|crocodile|
🐅|tiger|
🐆|leopard|
🦓|zebra|
🦍|gorilla|
🐘|elephant|
🦛|hippopotamus|
🦏|rhinoceros|
🐪|camel|
🦒|giraffe|
🦘|kangaroo|
🐃|water buffalo|
🐄|cow|
🐎|horse|
🐖|pig|
🐑|ewe|sheep
🐐|goat|
🦌|deer|
🐕|dog|
🐩|poodle|
🐈|cat|
🐈‍⬛|black cat|
🐓|rooster|
🦃|turkey|
🦚|peacock|
🦜|parrot|
🦢|swan|
🦩|flamingo|
🐇|rabbit|bunny
🦝|raccoon|
🦨|skunk|
🦦|otter|
🦥|sloth|lazy slow
🐁|mouse|
🐿|chipmunk|squirrel
🦔|hedgehog|
🐉|dragon|
🌵|cactus|
🎄|christmas tree|
🌲|evergreen tree|
🌳|deciduous tree|
🌴|palm tree|beach
🌱|seedling|plant grow
🌿|herb|leaf
☘|shamrock|
🍀|four leaf clover|luck lucky
🍁|maple leaf|autumn fall
🍂|fallen leaf|autumn
🍃|leaf fluttering in wind|
🍄|mushroom|
🌾|sheaf of rice|
💐|bouquet|flowers
🌷|tulip|flower
🌹|rose|flower love
🥀|wilted flower|sad
🌺|hibiscus|flower
🌸|cherry blossom|flower spring
🌼|blossom|flower
🌻|sunflower|flower
🌞|sun with face|sunny
🌝|full moon face|
🌛|first quarter moon face|
🌚|new moon face|
🌕|full moon|
🌙|crescent moon|night
🌎|globe showing americas|earth world
🌍|globe showing europe-africa|earth world
🌏|globe showing asia-australia|earth world
🪐|ringed planet|saturn space
💫|dizzy|star
⭐|star|favorite
🌟|glowing star|shine
✨|sparkles|shiny magic new
⚡|high voltage|lightning zap power
☄|comet|
💥|collision|boom
🔥|fire|lit hot flame
🌪|tornado|
🌈|rainbow|
☀|sun|sunny weather
🌤|sun behind small cloud|weather
⛅|sun behind cloud|weather
☁|cloud|weather
🌧|cloud with rain|rain weather
⛈|cloud with lightning and rain|storm weather
🌩|cloud with lightning|storm
❄|snowflake|snow cold winter
☃|snowman|snow winter
⛄|snowman without snow|winter
🌬|wind face|wind
💧|droplet|water
🌊|water wave|ocean sea
`,
  },
  {
    id: 'food',
    label: msg('Food & Drink'),
    icon: '🍔',
    list: `
🍏|green apple|fruit
🍎|red apple|fruit
🍐|pear|fruit
🍊|tangerine|orange fruit
🍋|lemon|fruit sour
🍌|banana|fruit
🍉|watermelon|fruit
🍇|grapes|fruit
🍓|strawberry|fruit
🫐|blueberries|fruit
🍈|melon|fruit
🍒|cherries|fruit
🍑|peach|fruit
🥭|mango|fruit
🍍|pineapple|fruit
🥥|coconut|fruit
🥝|kiwi fruit|fruit
🍅|tomato|
🍆|eggplant|aubergine
🥑|avocado|
🥦|broccoli|vegetable
🥬|leafy green|vegetable
🥒|cucumber|vegetable
🌶|hot pepper|spicy chili
🫑|bell pepper|vegetable
🌽|ear of corn|
🥕|carrot|vegetable
🧄|garlic|
🧅|onion|
🥔|potato|
🍠|roasted sweet potato|
🥐|croissant|bread
🥯|bagel|bread
🍞|bread|toast
🥖|baguette bread|bread french
🥨|pretzel|
🧀|cheese wedge|cheese
🥚|egg|
🍳|cooking|egg breakfast
🧈|butter|
🥞|pancakes|breakfast
🧇|waffle|breakfast
🥓|bacon|breakfast
🥩|cut of meat|steak
🍗|poultry leg|chicken
🍖|meat on bone|
🌭|hot dog|
🍔|hamburger|burger
🍟|french fries|fries chips
🍕|pizza|
🫓|flatbread|
🥪|sandwich|
🌮|taco|mexican
🌯|burrito|mexican
🥗|green salad|salad healthy
🥘|shallow pan of food|paella
🍝|spaghetti|pasta
🍜|steaming bowl|ramen noodles
🍲|pot of food|stew soup
🍛|curry rice|curry
🍣|sushi|japanese
🍱|bento box|japanese
🥟|dumpling|
🍤|fried shrimp|tempura
🍙|rice ball|onigiri
🍚|cooked rice|rice
🍘|rice cracker|
🍢|oden|
🍡|dango|
🍧|shaved ice|
🍨|ice cream|dessert
🍦|soft ice cream|dessert
🥧|pie|dessert
🧁|cupcake|dessert
🍰|shortcake|cake dessert
🎂|birthday cake|cake birthday party
🍮|custard|pudding dessert
🍭|lollipop|candy
🍬|candy|sweet
🍫|chocolate bar|chocolate
🍿|popcorn|movie
🍩|doughnut|donut
🍪|cookie|
🥜|peanuts|nuts
🍯|honey pot|honey
🥛|glass of milk|milk
🍼|baby bottle|milk
☕|hot beverage|coffee tea
🍵|teacup without handle|tea
🧃|beverage box|juice
🥤|cup with straw|soda drink
🧋|bubble tea|boba
🍶|sake|
🍺|beer mug|beer
🍻|clinking beer mugs|cheers beer
🥂|clinking glasses|cheers champagne celebrate
🍷|wine glass|wine
🥃|tumbler glass|whiskey
🍸|cocktail glass|cocktail martini
🍹|tropical drink|cocktail
🍾|bottle with popping cork|champagne celebrate
🧊|ice|cube cold
🥄|spoon|
🍴|fork and knife|cutlery food
🍽|fork and knife with plate|dinner
🥢|chopsticks|
🧂|salt|
`,
  },
  {
    id: 'activities',
    label: msg('Activities'),
    icon: '⚽',
    list: `
⚽|soccer ball|football
🏀|basketball|
🏈|american football|
⚾|baseball|
🥎|softball|
🎾|tennis|
🏐|volleyball|
🏉|rugby football|
🥏|flying disc|frisbee
🎱|pool 8 ball|billiards
🏓|ping pong|table tennis
🏸|badminton|
🏒|ice hockey|
🥅|goal net|
⛳|flag in hole|golf
🏹|bow and arrow|archery
🎣|fishing pole|fishing
🥊|boxing glove|boxing
🥋|martial arts uniform|karate
🛹|skateboard|
🛼|roller skate|
⛸|ice skate|skating
🎿|skis|ski
🏆|trophy|win winner champion
🥇|1st place medal|gold first winner
🥈|2nd place medal|silver second
🥉|3rd place medal|bronze third
🏅|sports medal|medal
🎖|military medal|
🎗|reminder ribbon|
🎫|ticket|
🎟|admission tickets|ticket
🎪|circus tent|
🎭|performing arts|theater drama
🎨|artist palette|art paint
🎬|clapper board|movie film
🎤|microphone|sing karaoke mic
🎧|headphone|music audio
🎼|musical score|music
🎹|musical keyboard|piano music
🥁|drum|music
🎷|saxophone|music
🎺|trumpet|music
🎸|guitar|music rock
🎻|violin|music
🎲|game die|dice random
♟|chess pawn|chess
🎯|direct hit|target bullseye
🎳|bowling|
🎮|video game|controller gaming games
🕹|joystick|gaming arcade
🎰|slot machine|casino gamble
🧩|puzzle piece|puzzle
🃏|joker|cards
🀄|mahjong red dragon|
🎴|flower playing cards|
🎉|party popper|party celebrate tada congrats
🎊|confetti ball|party celebrate
🎈|balloon|party birthday
🎁|wrapped gift|present gift birthday
🎀|ribbon|
🪅|piñata|party
🎃|jack-o-lantern|halloween pumpkin
🎆|fireworks|celebrate
🎇|sparkler|celebrate
🧨|firecracker|
`,
  },
  {
    id: 'travel',
    label: msg('Travel & Places'),
    icon: '🚗',
    list: `
🚗|automobile|car
🚕|taxi|car
🚙|sport utility vehicle|car suv
🚌|bus|
🏎|racing car|race fast
🚓|police car|
🚑|ambulance|
🚒|fire engine|
🚚|delivery truck|truck
🚜|tractor|
🛵|motor scooter|
🏍|motorcycle|
🚲|bicycle|bike
🛴|kick scooter|
🚨|police car light|alert siren
🚦|vertical traffic light|
🛑|stop sign|stop
🚧|construction|wip work in progress
⚓|anchor|
⛵|sailboat|boat
🚤|speedboat|boat
🛳|passenger ship|cruise
🚢|ship|
✈|airplane|plane flight travel
🛫|airplane departure|takeoff
🛬|airplane arrival|landing
🪂|parachute|
🚁|helicopter|
🚀|rocket|launch ship space
🛸|flying saucer|ufo
🚂|locomotive|train
🚆|train|
🚇|metro|subway
🗺|world map|map
🗽|statue of liberty|
🗼|tokyo tower|
🏰|castle|
🎡|ferris wheel|
🎢|roller coaster|
⛲|fountain|
🏖|beach with umbrella|beach vacation
🏝|desert island|island vacation
🏜|desert|
🌋|volcano|
⛰|mountain|
🏔|snow-capped mountain|
🏕|camping|camp
⛺|tent|camping
🏠|house|home
🏡|house with garden|home
🏢|office building|work office
🏥|hospital|
🏦|bank|
🏨|hotel|
🏫|school|
⛪|church|
🌃|night with stars|city night
🌆|cityscape at dusk|city
🌅|sunrise|morning
🌄|sunrise over mountains|morning
🌇|sunset|evening
🌉|bridge at night|
🎠|carousel horse|
⌛|hourglass done|time
⏳|hourglass not done|time wait loading
⌚|watch|time
⏰|alarm clock|time wake
⏱|stopwatch|time
🕐|one o’clock|time
`,
  },
  {
    id: 'objects',
    label: msg('Objects'),
    icon: '💡',
    list: `
👓|glasses|
🕶|sunglasses|cool
👔|necktie|shirt
👕|t-shirt|shirt
👖|jeans|
🧣|scarf|
🧤|gloves|
🧥|coat|
🧦|socks|
👗|dress|
👙|bikini|
👜|handbag|bag
🎒|backpack|school bag
👟|running shoe|sneaker
👠|high-heeled shoe|heels
👑|crown|king queen royal
🎩|top hat|hat
🧢|billed cap|hat cap
⛑|rescue worker’s helmet|helmet
💄|lipstick|makeup
💍|ring|wedding engagement
💎|gem stone|diamond jewel
🔇|muted speaker|mute silent
🔈|speaker low volume|sound
🔊|speaker high volume|loud sound
📢|loudspeaker|announcement
📣|megaphone|announcement
🔔|bell|notification
🔕|bell with slash|mute silent
🎵|musical note|music
🎶|musical notes|music
📱|mobile phone|phone cell
☎|telephone|phone call
📞|telephone receiver|phone call
🔋|battery|power
🔌|electric plug|power
💻|laptop|computer
🖥|desktop computer|computer pc
🖨|printer|
⌨|keyboard|type
🖱|computer mouse|click
💾|floppy disk|save
💿|optical disk|cd
📀|dvd|
🎥|movie camera|film video
📺|television|tv
📷|camera|photo picture
📸|camera with flash|photo
📹|video camera|video
🔍|magnifying glass tilted left|search find zoom
🔎|magnifying glass tilted right|search find
🕯|candle|
💡|light bulb|idea
🔦|flashlight|
📔|notebook with decorative cover|
📕|closed book|book read
📖|open book|book read
📚|books|library read study
📓|notebook|
📒|ledger|
📃|page with curl|document
📄|page facing up|document file
📰|newspaper|news
🔖|bookmark|
🏷|label|tag
💰|money bag|money rich
🪙|coin|money
💵|dollar banknote|money cash
💸|money with wings|spend money
💳|credit card|money pay
🧾|receipt|
✉|envelope|mail email letter
📧|e-mail|email mail
📨|incoming envelope|mail
📩|envelope with arrow|mail send
📤|outbox tray|send
📥|inbox tray|receive
📦|package|box delivery ship
📫|closed mailbox with raised flag|mail
🗳|ballot box with ballot|vote
✏|pencil|write edit
✒|black nib|pen write
🖋|fountain pen|pen write
🖊|pen|write
🖌|paintbrush|art paint
🖍|crayon|draw
📝|memo|note write todo
💼|briefcase|work business
📁|file folder|folder
📂|open file folder|folder
📅|calendar|date
📆|tear-off calendar|date
📇|card index|
📈|chart increasing|graph up stonks growth
📉|chart decreasing|graph down
📊|bar chart|graph stats
📋|clipboard|
📌|pushpin|pin
📍|round pushpin|pin location
📎|paperclip|attachment
✂|scissors|cut
🗑|wastebasket|trash delete bin
🔒|locked|lock secure private
🔓|unlocked|unlock open
🔑|key|password
🗝|old key|
🔨|hammer|tool build
🪓|axe|
⛏|pick|mine
🛠|hammer and wrench|tools build fix
🗡|dagger|knife
⚔|crossed swords|fight battle
🛡|shield|protect security
🔧|wrench|tool fix settings
🪛|screwdriver|tool
🔩|nut and bolt|
⚙|gear|settings cog
🧲|magnet|
🧪|test tube|science experiment
🧬|dna|science biology
🔬|microscope|science
🔭|telescope|space
📡|satellite antenna|
💉|syringe|vaccine shot
💊|pill|medicine
🩹|adhesive bandage|bandaid
🧹|broom|clean
🧺|basket|laundry
🧻|roll of paper|toilet
🧼|soap|clean
🛒|shopping cart|shop
🚬|cigarette|smoking
🗿|moai|stone face
🪦|headstone|rip grave
⚰|coffin|dead
🔮|crystal ball|fortune magic
🧿|nazar amulet|evil eye
🎮|video game|controller gaming
`,
  },
  {
    id: 'symbols',
    label: msg('Symbols'),
    icon: '❤',
    list: `
✅|check mark button|yes done ok correct
☑|check box with check|done
✔|check mark|yes done ok
❌|cross mark|no wrong x cancel
❎|cross mark button|no
➕|plus|add
➖|minus|subtract
➗|divide|
✖|multiply|x
❓|red question mark|question what
❔|white question mark|question
❗|red exclamation mark|important warning
❕|white exclamation mark|
‼|double exclamation mark|
⁉|exclamation question mark|what
⚠|warning|caution alert
🚫|prohibited|no forbidden ban
⛔|no entry|stop forbidden
📛|name badge|
🔞|no one under eighteen|nsfw 18
♻|recycling symbol|recycle
💲|heavy dollar sign|money
🆗|ok button|ok
🆕|new button|new
🆒|cool button|cool
🆓|free button|free
🆙|up! button|up
🆘|sos button|help emergency
🔴|red circle|
🟠|orange circle|
🟡|yellow circle|
🟢|green circle|online
🔵|blue circle|
🟣|purple circle|
⚫|black circle|
⚪|white circle|
🟥|red square|
🟩|green square|
🟦|blue square|
⬛|black large square|
⬜|white large square|
🔶|large orange diamond|
🔷|large blue diamond|
🔺|red triangle pointed up|
🔻|red triangle pointed down|
💠|diamond with a dot|
🔘|radio button|
⬆|up arrow|
➡|right arrow|
⬇|down arrow|
⬅|left arrow|
↩|right arrow curving left|back return reply
↪|left arrow curving right|forward
🔄|counterclockwise arrows button|refresh reload sync
🔁|repeat button|repeat loop
🔀|shuffle tracks button|shuffle random
▶|play button|play
⏸|pause button|pause
⏹|stop button|stop
⏩|fast-forward button|fast
⏪|fast reverse button|rewind
🔜|soon arrow|soon
🔝|top arrow|top
🔛|on! arrow|
🔚|end arrow|
🔙|back arrow|back
1️⃣|keycap one|one 1
2️⃣|keycap two|two 2
3️⃣|keycap three|three 3
4️⃣|keycap four|four 4
5️⃣|keycap five|five 5
6️⃣|keycap six|six 6
7️⃣|keycap seven|seven 7
8️⃣|keycap eight|eight 8
9️⃣|keycap nine|nine 9
0️⃣|keycap zero|zero 0
🔟|keycap ten|ten 10
#️⃣|keycap number sign|hash
*️⃣|keycap asterisk|star
🔢|input numbers|
🔤|input latin letters|abc
ℹ|information|info
Ⓜ|circled m|
🅰|a button|blood
🅱|b button|blood
🆎|ab button|blood
🅾|o button|blood
♈|aries|zodiac
♉|taurus|zodiac
♊|gemini|zodiac
♋|cancer|zodiac
♌|leo|zodiac
♍|virgo|zodiac
♎|libra|zodiac
♏|scorpio|zodiac
♐|sagittarius|zodiac
♑|capricorn|zodiac
♒|aquarius|zodiac
♓|pisces|zodiac
☮|peace symbol|peace
☯|yin yang|balance
♾|infinity|forever
⚛|atom symbol|science
🏳️‍🌈|rainbow flag|pride lgbt
🏴‍☠️|pirate flag|pirate
🏁|chequered flag|race finish
🚩|triangular flag|red flag warning
🏳|white flag|surrender
🏴|black flag|
©|copyright|
®|registered|
™|trade mark|tm
🔅|dim button|brightness
🔆|bright button|brightness
📶|antenna bars|signal wifi
🎦|cinema|movie
🛜|wireless|wifi internet
💤|zzz|sleep
`,
  },
  {
    id: 'flags',
    label: msg('Flags'),
    icon: '🏁',
    list: `
🇧🇷|flag: brazil|br brasil
🇵🇹|flag: portugal|pt
🇺🇸|flag: united states|us usa america
🇬🇧|flag: united kingdom|uk britain england
🇨🇦|flag: canada|ca
🇲🇽|flag: mexico|mx
🇦🇷|flag: argentina|ar
🇨🇱|flag: chile|cl
🇨🇴|flag: colombia|co
🇺🇾|flag: uruguay|uy
🇵🇾|flag: paraguay|py
🇵🇪|flag: peru|pe
🇪🇸|flag: spain|es
🇫🇷|flag: france|fr
🇩🇪|flag: germany|de
🇮🇹|flag: italy|it
🇳🇱|flag: netherlands|nl
🇧🇪|flag: belgium|be
🇨🇭|flag: switzerland|ch
🇦🇹|flag: austria|at
🇮🇪|flag: ireland|ie
🇸🇪|flag: sweden|se
🇳🇴|flag: norway|no
🇩🇰|flag: denmark|dk
🇫🇮|flag: finland|fi
🇵🇱|flag: poland|pl
🇺🇦|flag: ukraine|ua
🇷🇺|flag: russia|ru
🇬🇷|flag: greece|gr
🇹🇷|flag: turkey|tr
🇮🇱|flag: israel|il
🇪🇬|flag: egypt|eg
🇿🇦|flag: south africa|za
🇳🇬|flag: nigeria|ng
🇦🇴|flag: angola|ao
🇲🇿|flag: mozambique|mz
🇮🇳|flag: india|in
🇨🇳|flag: china|cn
🇯🇵|flag: japan|jp
🇰🇷|flag: south korea|kr
🇦🇺|flag: australia|au
🇳🇿|flag: new zealand|nz
🇪🇺|flag: european union|eu
🇺🇳|flag: united nations|un
`,
  },
]
