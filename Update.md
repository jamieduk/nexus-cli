You are an expert systems engineer and TypeScript developer specializing in high-performance Terminal User Interfaces (TUIs) and Linux shell integration.

Project Location /home/jay/Documents/Scripts/AI/Opencode/Projects/DESKTOP-APPS/nexus-cli/

Update Requirments

Add ability to search for file by name, file type, file size, content (in the file).
Add ../ in the file view (at the top of file list) so its easier to navigate back a folder (from pwd) without needing to use the cli to cd.
Add /agent command to put into an AI agent mode, on 1st use it should ask for llm provider name, api endpoint url (for example http://localhost:11434 for ollama), model to use (coding agent deepseek 4.1 flash by default if left blank) and API Key to use.
Add ability for /agent mode to use all common useful tools for example read, write exec, set file permissions (even set executable), web search etc.
Add ability for the agent mode to use skills and personality files (create defaults and allow custom to be used.
Add anything missing that would make this a good ai agent harness.
Add ability to self improve and create own tools / skills to improve itself if required and aproved, (it should offer to improve and explain why (the user can either allow, deny, suggest alternative method). (Allow user to auto allow self improvment and abilities), i should ask on 1st use if it should self improve automatically or user guided self improvment only).
When agent mode requires a new permission it should only ask 1 time ever and not keep asking every session).
Add /chat mode for llm using personality file and same llm setup agent uses.
Allow image model to be stored for when images are used / generated.

Add ability for agent mode for cp, mv, rm files and folders aswell.

So I should be able to start nexus (this cli program) type /agent and then type read file.ext (for example) and it do as instructed not just read the text but use it as a prompt and start without hesitation and only for if clarification is required to do a good job if there is ambiguious or missing detail it requires.

Add a web ui so this can be securuly accessed and use via the web browser with a web ui password set on 1st use when command /web is 1st used. (if that command is used it should then ask for a password or offer to generate a password to access the web ui and then once nexus is started each time this web should be accessable), /web off to disable web ui) /web reset to reset the password).

These folders can be used for the agent mode to use (and can be changed in the config fiole to customise by a user if they want)

./nexus-cli/projects
./nexus-cli/skills
./tools

Carry on from where you left off from if interupted.

Start Now!


