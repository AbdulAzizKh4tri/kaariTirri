
const socket = io({ autoConnect: false });
const ding = new Audio('sounds/discord_ding.mp3');
ding.volume = 0.2;

const userNameInput = document.getElementById('userName');
const roomInput = document.getElementById('roomId');
const joinBtn = document.getElementById('joinBtn');

const userNameDisplay = document.getElementById('userNameDisplay');
const startGameBtn = document.getElementById('startGame');

const auctionPanel = document.getElementById('auctionPanel');
const bidAmountInput = document.getElementById('bidAmount');
const bidBtn = document.getElementById('bidBtn');
const passBtn = document.getElementById('passBtn');

const powerSuitPanel = document.getElementById('powerSuitPanel');
const powerSuitSelect = document.getElementById('powerSuitSelect');
const powerSuitBtn = document.getElementById('powerSuitBtn');

const partnerSelectionPanel = document.getElementById('partnerSelectionPanel')
const partnerSelect = document.getElementById('partnerSelect')
const partnerSelectBtn = document.getElementById('partnerSelectBtn');

const chatSection = document.getElementById('chatSection');
const sendBtn = document.getElementById('sendBtn');
const messageInput = document.getElementById('message');
const messagesDiv = document.getElementById('messages');

const joinSection = document.getElementById('joinSection');
const gameWrapper = document.getElementById('gameWrapper');

const roundOutput = document.getElementById('roundOutput');
const roundLeader = document.getElementById('roundLeader');
const roundScore = document.getElementById('roundScore');

const playerHandDiv = document.getElementById('playerHandDiv');

var gameState = {}
var playerName = ""

function updateStagePanels(publicState, playerName){
    startGameBtn.hidden = true;

    if(publicState.stage == "auction"){
        auctionPanel.hidden = false;
        powerSuitPanel.hidden = true;
        partnerSelectionPanel.hidden = true;
    }else if(publicState.stage == "powerSuitSelection" && publicState.highestBidder == playerName){
        auctionPanel.hidden = true;
        powerSuitPanel.hidden = false;
        partnerSelectionPanel.hidden = true;
    }else if(publicState.stage == "partnerSelection" && publicState.highestBidder == playerName){
        auctionPanel.hidden = true;
        powerSuitPanel.hidden = true;
        partnerSelectionPanel.hidden = false;

        publicState.defaultDeck.forEach(card => {
            const option = document.createElement('option')
            option.value =  JSON.stringify(card);
            option.innerHTML = `${card.number} of ${card.suit}`
            partnerSelect.appendChild(option)
        });
    }else if(publicState.stage == "gameOver"){
        auctionPanel.hidden = true;
        powerSuitPanel.hidden = true;
        partnerSelectionPanel.hidden = true;
        startGameBtn.hidden = false;
    }else{
        auctionPanel.hidden = true;
        powerSuitPanel.hidden = true;
        partnerSelectionPanel.hidden = true;
    }
    
}

joinBtn.addEventListener('click', () => {
    const roomId = roomInput.value.trim();
    const name = userNameInput.value.trim();
    if (!roomId || !name) return;

    socket.connect();

    socket.emit('joinRoom', { roomId, name });
    playerName = name;

    joinSection.classList.add("d-none");
    gameWrapper.classList.remove("d-none");
    userNameDisplay.textContent = name;
});

sendBtn.addEventListener('click', () => {
    const msg = messageInput.value.trim();
    if (!msg) return;
    socket.emit('message', msg);
    messageInput.value = '';
});

startGameBtn.addEventListener('click', () => {
    socket.emit('gameStart');
});

bidBtn.addEventListener('click', () => {
    const bidAmount = parseInt(bidAmountInput.value);
    if (isNaN(bidAmount) || bidAmount < 0) return;
    socket.emit('bidPlaced', bidAmount);
    bidAmountInput.value = '';
});
passBtn.addEventListener('click', () => {
    socket.emit('bidPlaced', 0);
})

powerSuitBtn.addEventListener('click', ()=>{
    const powerSuit = powerSuitSelect.value;
    if(!powerSuit) return
    socket.emit('powerSuitSelected', powerSuit);
})

partnerSelectBtn.addEventListener('click', ()=>{
    const select = document.getElementById('partnerSelect');
    const values = Array.from(select.selectedOptions).map(o => JSON.parse(o.value));

    socket.emit('partnersSelected', values);

})

socket.on('gameStateUpdate', (data) => {
    gameState = data;
    const hand = gameState.playerGameState.hand;
    playerHandDiv.innerHTML = '';

    updateStagePanels(gameState.public, playerName);

    const grouped = {
        Spades: [],
        Hearts: [],
        Diamonds: [],
        Clubs: []
    };

    hand?.forEach(card => {
        grouped[card.suit].push(card);
    });

    for (const suit in grouped) {
        grouped[suit].sort((a, b) => b.power - a.power);
        const h4 = document.createElement('h4')
        h4.innerHTML = suit

        playerHandDiv.appendChild(h4)

        const div = document.createElement('div');
        div.classList.add('btn-group')
        grouped[suit].forEach(card => {
            const card_img = document.createElement('img');
            card_img.classList.add(`${suit.toLowerCase()}`, 'hand_card');
            card_img.src = `/cards/${card.suit.toLowerCase()}/${card.number.toLowerCase()}.png`;
            card_img.style.width = '80px';

            card_img.alt = `${card.number} of ${card.suit}`;

            card_img.addEventListener('click',()=>{
                socket.emit('cardPlayed', card);
            })
            div.appendChild(card_img)
        })
        playerHandDiv.appendChild(div)
    }
    
    roundScore.innerHTML = gameState.public.roundScore;
    roundLeader.innerHTML = gameState.public.roundLeader;

    roundOutput.innerHTML = '';        
    gameState.public.round.forEach(roundEntry => {
        const card = roundEntry.card;
        const playerName = roundEntry.playerName; 

        // Wrapper for card + name
        const cardWrapper = document.createElement('div');
        cardWrapper.classList.add('card-played'); 

        const card_img = document.createElement('img');
        card_img.src = `/cards/${card.suit.toLowerCase()}/${card.number.toLowerCase()}.png`;
        card_img.style.width = '80px';
        card_img.alt = `${card.number} of ${card.suit}`;

        const label = document.createElement('div');
        label.classList.add('card-player-name'); 
        label.textContent = playerName;

        cardWrapper.appendChild(card_img);
        cardWrapper.appendChild(label);

        roundOutput.appendChild(cardWrapper);
    });

    if(gameState.public.stage == "gameOver"){
        roundOutput.innerHTML += `<h2 class="text-center">Game Over! Winners: ${gameState.public.gameWinners}</h2>`
    }


});

socket.on('message', (msg) => {
    messagesDiv.innerHTML += `<p class="msg">${msg}</p>`;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    ding.play();
});

socket.on('bulkMessage', (msgs)=>{
    msgs.forEach(msg => {
        messagesDiv.innerHTML += `<p class="msg">${msg}</p>`;
    });
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    ding.play();
})

socket.on('connect', () => {
    messagesDiv.innerHTML += `<p class="sys">Connected to server</p>`;
    document.getElementById('roomID').textContent = roomInput.value.trim();
});

socket.on('disconnect', () => {
    messagesDiv.innerHTML += `<p class="sys">Disconnected</p>`;
});