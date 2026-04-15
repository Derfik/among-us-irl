const http = require('http');

const PORT = process.env.PORT || 3000;

const page = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Among Us IRL</title>
</head>
<body>

<h1>Among Us IRL</h1>

<input id="name" placeholder="Your name">
<button onclick="createRoom()">Create Room</button>

<script>
async function createRoom() {
  const res = await fetch('/api/test');
  const data = await res.json();
  alert(data.message);
}
</script>

</body>
</html>
`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(page);
  }

  else if (req.url === '/api/test') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ message: "It works 🔥" }));
  }

  else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log("Running on " + PORT);
});
