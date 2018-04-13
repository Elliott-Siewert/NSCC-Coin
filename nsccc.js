

//api urls
apiBalance = 'http://localhost:3002/balance';
apiAddress = 'http://localhost:3002/address';
apiSendTransaction = 'http://localhost:3002/sendTransaction';
apiMineBlock = 'http://localhost:3002/mineBlock';
apiMineChain = 'http://localhost:3002/mineChain';
apiStopMiningChain = 'http://localhost:3002/stopMiningChain';

//vars to send txn
sendAddress = "";
sendAmount = 0;


setInterval(() =>{
    var http =  new XMLHttpRequest();
    http.open("GET", apiBalance, true);
    http.onreadystatechange = function(){
        if(http.readyState == 4 && http.status == 200) {
            document.getElementById("balance").innerHTML = JSON.parse(http.response).balance;
        }
    };
    http.send();
    },1000);


function getAddress(){
    console.log("test");
    var http =  new XMLHttpRequest();
    http.open("GET", apiAddress, true);
    http.onreadystatechange = function(){
        if(http.readyState == 4 && http.status == 200) {
            console.log(http.response);
            document.getElementById("address").innerHTML = JSON.parse(http.response).address;
        }
    };
    http.send();
}

function sendTransaction(){
    var http =  new XMLHttpRequest();
    http.open("POST", apiSendTransaction, true);
    http.setRequestHeader("Content-type", "application/json");
    //var params = "address=" + document.getElementById("sendAddress").value + "?amount=" + document.getElementById("sendAmount").value;
    var params = {address:  document.getElementById("sendAddress").value, amount: parseInt(document.getElementById("sendAmount").value)};
    console.log(params);
    http.send(JSON.stringify(params));
}


getAddress();



