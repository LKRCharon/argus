import Foundation

/// `argus help` — static usage block.
enum HelpCommand: CLISubcommand {
    static let usage = """
    Argus — menu bar utility to keep macOS awake while agents work.

    USAGE:
      argus on [--for <dur>] [--forever]   (default: auto-release in 2h)
      argus off
      argus status [--json]
      argus repair                         (repair a wedged/unreachable helper)
      argus keep --while <pid>
      argus watch <agent> [--grace s] [--check-interval s] [--max minutes] [--json]
      argus session start <name> [--message <text>] [--json]
      argus session stop <name>
      argus session list [--json]
      argus debug [agents] [--json]
      argus monitor                        (open the monitor window)
      argus help

    EXIT CODES:
      0  success
      1  bad arguments
      2  helper unreachable
      3  helper requires approval
      4  user cancel (keep / watch / session)
    """

    static func run(args: [String]) -> Int32 {
        printUsage()
        return 0
    }

    static func printUsage() {
        print(usage)
    }
}
