/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as child_process from 'child_process';
import * as os from 'os';
import { AttachItem, AttachItemsProvider } from './attachToProcess';

class Process {
    constructor(public name: string, public pid: string, public commandLine: string) { }

    public toAttachItem(): AttachItem {
        return {
            label: this.name,
            description: this.pid,
            detail: this.commandLine,
            id: this.pid
        }
    }
}

export class NativeAttachItemsProviderFactory {
    static Get(): AttachItemsProvider {
        if (os.platform() === 'win32') {
            return new WmicAttachItemsProvider();
        }
        else {
            return new PsAttachItemsProvider();
        }
    }
}

abstract class NativeAttachItemsProvider implements AttachItemsProvider {
    protected abstract getInternalProcessEntries(): Promise<Process[]>;

    getAttachItems(): Promise<AttachItem[]> {
        return this.getInternalProcessEntries().then(processEntries => {
            // localeCompare is significantly slower than < and > (2000 ms vs 80 ms for 10,000 elements)
            // We can change to localeCompare if this becomes an issue
            processEntries.sort((a, b) => {
                if (a.name == undefined) {
                    if (b.name == undefined)
                        return 0;
                    return 1;
                }
                if (b.name == undefined)
                    return -1;
                let aLower = a.name.toLowerCase();
                let bLower = b.name.toLowerCase();
                if (aLower == bLower)
                    return 0;
                return aLower < bLower ? -1 : 1;
            });
            let attachItems = processEntries.map(p => p.toAttachItem());
            return attachItems;
        })
    }
}

export class PsAttachItemsProvider extends NativeAttachItemsProvider {
    // Perf numbers:
    // OS X 10.10
    // | # of processes | Time (ms) |
    // |----------------+-----------|
    // |            272 |        52 |
    // |            296 |        49 |
    // |            384 |        53 |
    // |            784 |       116 |
    //
    // Ubuntu 16.04
    // | # of processes | Time (ms) |
    // |----------------+-----------|
    // |            232 |        26 |
    // |            336 |        34 |
    // |            736 |        62 |
    // |           1039 |       115 |
    // |           1239 |       182 |

    // ps outputs as a table. With the option "ww", ps will use as much width as necessary.
    // However, that only applies to the right-most column. Here we use a hack of setting
    // the column header to 50 a's so that the second column will have at least that many
    // characters. 50 was chosen because that's the maximum length of a "label" in the
    // QuickPick UI in VSCode.

    protected getInternalProcessEntries(): Promise<Process[]> {
        let processCmd: string = '';
        switch (os.platform()) {
            case 'darwin':
                processCmd = PsProcessParser.psDarwinCommand;
                break;
            case 'linux':
                processCmd = PsProcessParser.psLinuxCommand;
                break;
            default:
                return Promise.reject<Process[]>(new Error(`Operating system "${os.platform()}" not support.`));
        }
        return execChildProcess(processCmd, null).then(processes => {
            return PsProcessParser.ParseProcessFromPs(processes);
        });
    }
}

export class PsProcessParser {
    private static get secondColumnCharacters() { return 50; }
    private static get commColumnTitle(): string { return Array(PsProcessParser.secondColumnCharacters).join("a"); }
    // the BSD version of ps uses '-c' to have 'comm' only output the executable name and not
    // the full path. The Linux version of ps has 'comm' to only display the name of the executable
    // Note that comm on Linux systems is truncated to 16 characters:
    // https://bugzilla.redhat.com/show_bug.cgi?id=429565
    // Since 'args' contains the full path to the executable, even if truncated, searching will work as desired.
    public static get psLinuxCommand(): string { return `ps -axww -o pid=,comm=${PsProcessParser.commColumnTitle},args=`; }
    public static get psDarwinCommand(): string { return `ps -axww -o pid=,comm=${PsProcessParser.commColumnTitle},args= -c`; }

    // Only public for tests.
    public static ParseProcessFromPs(processes: string): Process[] {
        let lines = processes.split(os.EOL);
        return PsProcessParser.ParseProcessFromPsArray(lines);
    }

    public static ParseProcessFromPsArray(processArray: string[]): Process[] {
        let processEntries: Process[] = [];

        // lines[0] is the header of the table
        for (let i = 1; i < processArray.length; i++) {
            let line = processArray[i];
            if (!line) {
                continue;
            }

            let processEntry = PsProcessParser.parseLineFromPs(line);
            processEntries.push(processEntry);
        }

        return processEntries;
    }

    private static parseLineFromPs(line: string): Process {
        // Explanation of the regex:
        //   - any leading whitespace
        //   - PID
        //   - whitespace
        //   - executable name --> this is PsAttachItemsProvider.secondColumnCharacters - 1 because ps reserves one character
        //     for the whitespace separator
        //   - whitespace
        //   - args (might be empty)
        const psEntry = new RegExp(`^\\s*([0-9]+)\\s+(.{${PsProcessParser.secondColumnCharacters - 1}})\\s+(.*)$`);
        const matches = psEntry.exec(line);
        if (matches && matches.length === 4) {
            const pid = matches[1].trim();
            const executable = matches[2].trim();
            const cmdline = matches[3].trim();
            return new Process(executable, pid, cmdline);
        }
    }
}

/**
 * Originally from common.ts. Due to test code not having vscode, it was refactored to not have vscode.OutputChannel.
 */
function execChildProcess(process: string, workingDirectory: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        child_process.exec(process, { cwd: workingDirectory, maxBuffer: 500 * 1024 }, (error: Error, stdout: string, stderr: string) => {

            if (error) {
                reject(error);
                return;
            }

            if (stderr && stderr.length > 0) {
                reject(new Error(stderr));
                return;
            }

            resolve(stdout);
        });
    });
}

export class WmicAttachItemsProvider extends NativeAttachItemsProvider {
    // Perf numbers on Win10:
    // | # of processes | Time (ms) |
    // |----------------+-----------|
    // |            309 |       413 |
    // |            407 |       463 |
    // |            887 |       746 |
    // |           1308 |      1132 |

    protected getInternalProcessEntries(): Promise<Process[]> {
        const wmicCommand = 'wmic process get Name,ProcessId,CommandLine /FORMAT:list';
        return execChildProcess(wmicCommand, null).then(processes => {
            return WmicProcessParser.ParseProcessFromWmic(processes);
        });
    }
}

export class WmicProcessParser {
    private static get wmicNameTitle() { return 'Name'; }
    private static get wmicCommandLineTitle() { return 'CommandLine' };
    private static get wmicPidTitle() { return 'ProcessId'; }

    // Only public for tests.
    public static ParseProcessFromWmic(processes: string): Process[] {
        let lines = processes.split(os.EOL);
        let currentProcess: Process = new Process(null, null, null);
        let processEntries: Process[] = [];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (!line) {
                continue;
            }

            WmicProcessParser.parseLineFromWmic(line, currentProcess);

            // Each entry of processes has ProcessId as the last line
            if (line.lastIndexOf(WmicProcessParser.wmicPidTitle, 0) === 0) {
                processEntries.push(currentProcess);
                currentProcess = new Process(null, null, null);
            }
        }

        return processEntries;
    }

    private static parseLineFromWmic(line: string, process: Process) {
        let splitter = line.indexOf('=');
        if (splitter >= 0) {
            let key = line.slice(0, line.indexOf('=')).trim();
            let value = line.slice(line.indexOf('=') + 1).trim();
            if (key === WmicProcessParser.wmicNameTitle) {
                process.name = value;
            }
            else if (key === WmicProcessParser.wmicPidTitle) {
                process.pid = value;
            }
            else if (key === WmicProcessParser.wmicCommandLineTitle) {
                const extendedLengthPath = '\\??\\';
                if (value.lastIndexOf(extendedLengthPath, 0) === 0) {
                    value = value.slice(extendedLengthPath.length);
                }

                process.commandLine = value;
            }
        }
    }
}
