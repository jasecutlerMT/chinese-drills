#!/bin/bash
# Double-clickable launcher for the Chinese Drills app (macOS).
# Self-healing: installs dependencies if missing, restarts after in-app
# updates (.restart sentinel), and keeps the window open on errors.
#
# The whole body lives inside main() and is called on the last line. The
# in-app updater can overwrite this very file while bash is reading it, and
# bash reads scripts incrementally — a partial read of a flat script would
# execute half a command. Wrapped like this, bash must reach the final line
# before anything runs at all.

main() {
  # Appended, never prepended: Terminal has already given us the user's real
  # PATH, and an Intel Node left behind in /usr/local/bin must not be allowed
  # to outrank it — the compiled database module is built for whichever Node
  # installed it, and loads into that one only. These are a fallback for a
  # machine whose shell knows about neither.
  case ":$PATH:" in *":/opt/homebrew/bin:"*) ;; *) PATH="$PATH:/opt/homebrew/bin" ;; esac
  case ":$PATH:" in *":/usr/local/bin:"*) ;; *) PATH="$PATH:/usr/local/bin" ;; esac
  export PATH
  cd "$(dirname "$0")" || exit 1

  if ! command -v npm >/dev/null 2>&1; then
    echo "Node.js isn't installed. Download the LTS installer from https://nodejs.org and run it, then double-click this again."
    read -r -p "Press Enter to close…"
    exit 1
  fi

  # A present node_modules is not necessarily a working one — an update whose
  # install was interrupted leaves a folder that exists but cannot start the app.
  # Ask Node whether the framework actually resolves, not whether a folder exists.
  if [ ! -d node_modules ] || ! node -e "require.resolve('next')" >/dev/null 2>&1; then
    if [ -d node_modules ]; then
      echo "The app's components look incomplete — reinstalling them (about a minute)…"
    else
      echo "First run: installing the app's components (about a minute)…"
    fi
    npm install --no-audit --no-fund || {
      echo "Install failed — see the error above."
      read -r -p "Press Enter to close…"
      exit 1
    }
  fi

  # Open the browser once the server answers.
  (
    tries=0
    until curl -s http://localhost:3000 >/dev/null 2>&1; do
      sleep 1
      tries=$((tries + 1))
      [ "$tries" -ge 180 ] && exit 1
    done
    open "http://localhost:3000"
  ) &

  # Run the server; loop when an in-app update requests a restart.
  while :; do
    rm -f .restart
    npm run dev
    if [ -f .restart ]; then
      echo "Update installed — restarting…"
      continue
    fi
    break
  done

  echo
  echo "The app has stopped. If this was unexpected, read the messages above."
  read -r -p "Press Enter to close…"
}

main "$@"
