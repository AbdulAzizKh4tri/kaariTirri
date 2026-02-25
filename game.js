const helpers = require('./helpers')

class Card {
    constructor(suit, number, power, value) {
        this.suit = suit;
        this.number = number;
        this.power = power;
        this.value = value;
    }
}

const SPADES = 'Spades';
const HEARTS = 'Hearts';
const DIAMONDS = 'Diamonds';
const CLUBS = 'Clubs';

const SUITS = [SPADES, HEARTS, DIAMONDS, CLUBS];

// numeric power mapping
const powerMap = {
    Ace: 14,
    King: 13,
    Queen: 12,
    Jack: 11,
    10: 10,
    9: 9,
    8: 8,
    7: 7,
    6: 6,
    5: 5,
    4: 4,
    3: 3,
    2: 2,
};

// value mapping
function computeValue(suit, rank) {
    // high cards (Ace → 10)
    if (["Ace", "King", "Queen", "Jack", "10"].includes(rank)) {
        return 10;
    }
    // special rule: 3 of Spades = 30
    if (rank === "3" && suit === SPADES) return 30;
    // 5 gives 5 points
    if (rank === "5") return 5;
    // all others = 0
    return 0;
}

const RANKS = [
    "Ace","King","Queen","Jack","10",
    "9","8","7","6","5","4","3","2"
];

const defaultDeck = [];

for (const suit of SUITS) {
    for (const rank of RANKS) {
        const power = powerMap[rank];
        const value = computeValue(suit, rank);
        defaultDeck.push(new Card(suit, rank, power, value));
    }
}

const deckSize = defaultDeck.length;

function initialPlayerGameState() {
    return { hand: [] };
}

function initialGameState(players) {
    const count = players.length;
    // create a deck trimmed to divisible by player count
    const deck = defaultDeck.slice(0, deckSize - (deckSize % count));
    const shuffled = deck
        .map(v => ({ v, r: Math.random() }))
        .sort((a,b) => a.r - b.r)
        .map(o => o.v);

    const playerGameStates = Object.fromEntries(
        players.map(p => [p.name, initialPlayerGameState()])
    );

    // deal cards round-robin
    shuffled.forEach((card, i) => {
        const player = players[i % count].name;
        playerGameStates[player].hand.push(card);
    });

    return {
        public: {
            defaultDeck: deck,
            players: players.map(p => p.name), // array of names
            bidders: players.map(p => p.name),
            playerCount: players.length,
            powerSuit: null,
            partners: [], // this is partner CARDS (bad naming ik but too late to change)
            round: [],
            roundScore: 0,
            playerScores: Object.fromEntries(players.map(p=>[p.name,0])),
            turnIndex: null,
            stage: 'auction',
            currentBidIndex: Math.floor(Math.random() * players.length),
            highestBid: 120,
            highestBidder: null,
            gameWinners: null,
        },
        alpha: new Set(),
        beta: new Set(),
        alphaScore: 0,
        betaScore: 0,
        playerGameStates
    };
}

function getCurrentBidder(gameState) {
    const bidders = gameState.public.bidders;
    if (!bidders || bidders.length === 0) return null;
    const idx = gameState.public.currentBidIndex % bidders.length;
    return bidders[idx];
}

function handleAuctionWin(gameState, winnerName, messages) {
    const pub = gameState.public;

    pub.stage = 'powerSuitSelection';
    pub.highestBidder = winnerName;

    messages.push(`${winnerName} wins the auction`);

    return {
        status: 'ok',
        messages,
        auctionWon: true
    };
}

function placeBid(gameState, playerName, bidAmount) {
    const messages = [];
    const pub = gameState.public;

    if (!pub.bidders || pub.bidders.length === 0) {
        return { status: 'error', messages: ['No bidders'], auctionWon: false };
    }

    const currentBidder = pub.bidders[pub.currentBidIndex];

    // not player's turn
    if (currentBidder !== playerName) {
        return {
            status: 'wrongTurn',
            messages: [`Not your turn. It's ${currentBidder}'s turn to bid`],
            auctionWon: false
        };
    }

    const amount = Number(bidAmount) || 0;
    pub.highestBid = pub.highestBid || 120;

    // ---- RAISE ----
    if (amount > pub.highestBid) {
        pub.highestBid = amount;
        pub.highestBidder = playerName;

        messages.push(`${playerName} placed a bid of ${amount}`);

        // max bid → instant win
        if (amount === 250) {
            return handleAuctionWin(gameState, playerName, messages);
        }

        // move to next bidder
        pub.currentBidIndex = (pub.currentBidIndex + 1) % pub.bidders.length;

        if (pub.bidders.length === 1) {
            const winner = pub.highestBidder;
            if(winner) return handleAuctionWin(gameState, winner, messages);
        }

        return {
            status: 'ok',
            messages,
            auctionWon: false
        };
    }

    // ---- PASS ----
    messages.push(`${playerName} passes`);

    const idx = pub.bidders.indexOf(playerName);
    if (idx !== -1) {
        pub.bidders.splice(idx, 1);

        // adjust pointer
        if (pub.bidders.length > 0) {
            pub.currentBidIndex %= pub.bidders.length;
        }

        // no bidders → nobody bid; you may choose rules here
        if (pub.bidders.length === 0) {
            pub.highestBid = 125
            pub.highestBidder = pub.players[Math.floor(Math.random() * pub.players.length)]
            messages.push("All players passed, selecting winner at random")
            return handleAuctionWin(gameState, pub.highestBidder, messages);
        }

        // single bidder left → they win automatically
        if (pub.bidders.length === 1) {
            const winner = pub.highestBidder;
            if(winner) return handleAuctionWin(gameState, winner, messages);
        }

        return {
            status: 'ok',
            messages,
            auctionWon: false
        };
    }

    return {
        status: 'error',
        messages: ['Player not found in bidders'],
        auctionWon: false
    };
}

function selectPowerSuit(gameState, playerName, selectedSuit){
    gameState.public.powerSuit = selectedSuit;
    gameState.public.stage = 'partnerSelection';
    messages = []

    const partnerCount = Math.ceil(gameState.public.playerCount / 2) - 1;
    
    messages.push(`${playerName} selected ${selectedSuit} as the power suit`)
    
    return {
        messages,
        data:{partnerCount}
    }
}

function selectPartners(gameState, playerName, partners){
    gameState.public.partners = partners;
    messages = []

    const partnerCount = Math.ceil(gameState.public.playerCount / 2) - 1;
    if(partners.length > partnerCount) return {status: 'error', messages: ['too many partners']};
    
    gameState.public.stage = 'playing';
    
    gameState.alpha.add(playerName);

    partners.forEach(card =>{
        messages.push(`${playerName} selected ${card.number} of ${card.suit} as a partner`)

        for (const [player, state] of Object.entries(gameState.playerGameStates)) {
            if(player == playerName) continue;

            gameState.beta.add(player);

            const hasCard = state.hand.some(handCard => {
                return handCard.number == card.number && handCard.suit == card.suit
            })

            if(hasCard){
                gameState.alpha.add(player);
                gameState.beta.delete(player);
            }
        }
    })
    gameState.public.turnIndex = gameState.public.players.indexOf(playerName)

    return {messages}
}

function playCard(gameState, playerName, card){
    const pub = gameState.public
    messages = []
    if(pub.players[pub.turnIndex] != playerName) return {status: "error", messages: ["Not your turn to play"]};

    if(pub.round.length == pub.playerCount){
        pub.round = []
        pub.roundLeader = null
        pub.roundScore = 0
    }
    
    if(pub.round.length > 0 && pub.round.length < pub.playerCount){
        const leadSuit = pub.round[0].card.suit
        if(card.suit != leadSuit){
            const hasLeadSuit = gameState.playerGameStates[playerName].hand.some(c => c.suit == leadSuit)
            if(hasLeadSuit){
                messages.push(`${playerName} must follow suit ${leadSuit}`)
                return {status: "error", messages: [`${playerName} must follow suit ${leadSuit}`]};
            }
        }
    }
    
    const success = helpers.removeCard(gameState.playerGameStates[playerName].hand, card.suit, card.number)
    
    if(success){

        messages.push(`${playerName} played ${card.number} of ${card.suit}`)

        pub.turnIndex = (pub.turnIndex + 1) % pub.playerCount;
        const round = pub.round
        round.push({
            playerName,
            card,
            power: (card.suit==pub.powerSuit) ? card.power + 100 : card.power
        });
        const roundScore = round.reduce((sum, c) => sum + c.card.value, 0);
        const roundLeader = round.reduce((max, c) => (c.power > max.power ? c : max)).playerName
        pub.roundScore = roundScore
        pub.roundLeader = roundLeader
        
        if(round.length == pub.playerCount){
            pub.playerScores[roundLeader] += roundScore;

            if(gameState.alpha.has(roundLeader)){
                gameState.alphaScore += roundScore;
            }else{
                gameState.betaScore += roundScore;
            }

            pub.turnIndex = pub.players.indexOf(roundLeader)
            messages.push(`${roundLeader} won ${roundScore} points`)

            if(gameState.alphaScore >= pub.highestBid){
                messages.push(`${[...gameState.alpha]} win!`)
                pub.gameWinners = [...gameState.alpha]
                pub.stage = 'gameOver'
            }
            if(gameState.betaScore > 250 - pub.highestBid){
                messages.push(`${[...gameState.beta]} win!`)
                pub.gameWinners = [...gameState.beta]
                pub.stage = 'gameOver'
            }
        }

    }else{
        return {status: "error", messages: [`Card not found in hand`]};
    }
    
    return {
        messages,
    }
}

module.exports = {
    initialGameState,
    placeBid,
    getCurrentBidder,
    selectPowerSuit,
    selectPartners,
    playCard,
};

