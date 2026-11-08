Nexo Server
===========

Host a Nexo server for your friends: voice, chat and game streaming.

Start
-----
1. Double-click nexo-server.exe.
   Windows may say "Windows protected your PC" (the program isn't code-signed):
   click "More info", then "Run anyway".
2. The first time, it asks for a server name and a password for new friends
   (press Enter to keep the suggestions).
3. Windows Firewall asks to allow nexo-server.exe and livekit-server.exe:
   click "Allow" on both.
4. Send your friends what's in the "Invite your friends" box: the server
   address and the password. You join from this PC with http://localhost:3001

Keep the window open while you play. Ctrl+C stops the server.

If friends can't connect
------------------------
The window tells you how friends can reach you. If it says your internet
provider doesn't allow direct connections (CGNAT), or that automatic port
forwarding isn't available, use Tailscale: see the server guide below.

Commands (in a terminal, in this folder)
-----------------------------------------
  nexo-server            start (asks the setup questions the first time)
  nexo-server invite     show the invite again
  nexo-server status     is it running, who's online
  nexo-server setup      change the name, password or ports
  nexo-server backup     save a copy of the database
  nexo-server --help     everything else

Your data (database, pictures, settings, logs) is in
%LOCALAPPDATA%\Nexo Server

Server guide: https://github.com/campiohe/nexo/blob/main/docs/SERVER.md
Nexo app downloads: https://github.com/campiohe/nexo/releases

nexo-server.exe is MIT licensed (LICENSE.txt). livekit-server.exe is
LiveKit (https://livekit.io), Apache License 2.0 (livekit-LICENSE.txt).
