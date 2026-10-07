Put the OLD ce-solar-middleware files here to re-run the side-by-side comparison:

    server.js and screening-request.js from ce-solar-middleware, commit 169bc6c (v7.6)

Then, from the project folder:

    node tools/characterize.js

It starts the old server and the new app in one process, gives both the same fake
Salesforce, sends 19 requests to each, and compares every response and every Salesforce
call. These two old files are never committed (see .gitignore).
