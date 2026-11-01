#!/usr/bin/env python3
"""
Debug Tool for Headless-Wan2GP
==============================

Investigate tasks, workers, and system state.

Usage:
    debug.py task <task_id>             # Investigate specific task
    debug.py tasks                      # Analyze recent tasks
    debug.py logs                       # View system logs
    debug.py logs --latest              # View logs from most recent browser session

    # Cross-cutting diagnostics (cross-reference orchestrator + worker + task data)
    debug.py worker-timeline <id>       # Full lifecycle timeline for a worker
    debug.py why-killed <id>            # Diagnose why a worker was terminated
    debug.py task-journey <id>          # All state transitions for a task
    debug.py scaling-audit              # Audit recent orchestrator scaling decisions

Options:
    --json                              # Output as JSON
    --hours N                           # Time window in hours
    --limit N                           # Limit results
    --debug                             # Show debug info on errors

Examples:
    # Why did this worker get killed?
    debug.py why-killed gpu-20260330_105556-9de794f6

    # Trace a task through all its state changes across workers
    debug.py task-journey 0fd1be22-41ae-4214-8db9-71a12bce717f

    # See full worker lifecycle: spawn → init → claim → complete → kill
    debug.py worker-timeline gpu-20260330_104235-f64bf1a7

    # Find workers killed while productive, wasted spawns, churn rate
    debug.py scaling-audit --hours 6

    # Investigate why a task failed
    debug.py task 41345358-f3b5-418a-9805-b442aed30e18

    # Quick table lookup
    debug.py q tasks status=Failed --limit 10
"""

import sys
import argparse
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

from debug.client import DebugClient
from debug.commands import task, tasks, logs, sql, query, pipeline, workers, queue, pod
from debug.commands import worker_timeline, why_killed, task_journey, scaling_audit
from debug.commands import context as context_cmd


def create_parser() -> argparse.ArgumentParser:
    """Create argument parser."""
    parser = argparse.ArgumentParser(
        description='Debug tool for investigating tasks',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Command to run', required=True)
    
    # Task command
    task_parser = subparsers.add_parser('task', help='Investigate specific task')
    task_parser.add_argument('task_id', help='Task ID to investigate')
    task_parser.add_argument('--json', action='store_true', help='Output as JSON')
    task_parser.add_argument('--logs-only', action='store_true', help='Show only logs timeline')
    task_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')
    
    # Tasks command
    tasks_parser = subparsers.add_parser('tasks', help='Analyze recent tasks')
    tasks_parser.add_argument('--limit', type=int, default=50, help='Number of tasks (default: 50)')
    tasks_parser.add_argument('--status', help='Filter by status (e.g., Failed, Complete, Queued)')
    tasks_parser.add_argument('--type', help='Filter by task type')
    tasks_parser.add_argument('--hours', type=int, help='Filter by hours')
    tasks_parser.add_argument('--json', action='store_true', help='Output as JSON')
    tasks_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')
    
    # Query command (uses Supabase client — no extra deps)
    query_parser = subparsers.add_parser('query', aliases=['q'], help='Query a table (e.g. query shots id=abc)')
    query_parser.add_argument('table', help='Table name to query')
    query_parser.add_argument('filters', nargs='*', help='Filters as column=value pairs')
    query_parser.add_argument('--select', default='*', help='Columns to select (default: *)')
    query_parser.add_argument('--limit', type=int, default=50, help='Max rows (default: 50)')
    query_parser.add_argument('--json', action='store_true', help='Output as JSON')
    query_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')

    # SQL command (requires psycopg2 + DATABASE_URL)
    sql_parser = subparsers.add_parser('sql', help='Execute raw SQL (requires psycopg2)')
    sql_parser.add_argument('query', help='SQL query to execute')
    sql_parser.add_argument('--json', action='store_true', help='Output as JSON')
    sql_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')

    # Pipeline command
    pipeline_parser = subparsers.add_parser('pipeline', help='Trace orchestrator → children → stitch pipeline')
    pipeline_parser.add_argument('task_id', help='Any task ID in the pipeline (parent or child)')
    pipeline_parser.add_argument('--json', action='store_true', help='Output as JSON')
    pipeline_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')

    # Workers command
    workers_parser = subparsers.add_parser('workers', help='Show active workers, health, failure counts')
    workers_parser.add_argument('--all', action='store_true', help='Show all workers including terminated (default: active only)')
    workers_parser.add_argument('--json', action='store_true', help='Output as JSON')
    workers_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')

    # Queue command
    queue_parser = subparsers.add_parser('queue', help='Show current queue depth, stuck tasks, worker capacity')
    queue_parser.add_argument('--json', action='store_true', help='Output as JSON')
    queue_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')

    # Pod command
    pod_parser = subparsers.add_parser('pod', help='RunPod pod management (list, ssh, worker setup)')
    pod_parser.add_argument('subcommand', choices=['list', 'ssh', 'worker'], help='list=show pods, ssh=get SSH command, worker=print setup/start commands')
    pod_parser.add_argument('pod_id', nargs='?', help='Pod ID (required for ssh/worker)')
    pod_parser.add_argument('--json', action='store_true', help='Output as JSON')
    pod_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')

    # Worker timeline command
    wt_parser = subparsers.add_parser('worker-timeline', help='Show full lifecycle timeline for a worker')
    wt_parser.add_argument('worker_id', help='Worker ID (e.g. gpu-20260330_105556-9de794f6)')
    wt_parser.add_argument('--hours', type=int, default=6, help='Time window (default: 6)')
    wt_parser.add_argument('--json', action='store_true', help='Output as JSON')
    wt_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')

    # Why-killed command
    wk_parser = subparsers.add_parser('why-killed', help='Diagnose why a worker was terminated')
    wk_parser.add_argument('worker_id', help='Worker ID')
    wk_parser.add_argument('--json', action='store_true', help='Output as JSON')
    wk_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')

    # Task journey command
    tj_parser = subparsers.add_parser('task-journey', help='Show all state transitions for a task')
    tj_parser.add_argument('task_id', help='Task ID')
    tj_parser.add_argument('--json', action='store_true', help='Output as JSON')
    tj_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')

    # Context command
    ctx_parser = subparsers.add_parser('context', help='Show full relational graph for a task or generation (parent/children, shot timeline, issues)')
    ctx_parser.add_argument('entity_id', help='Task ID or generation ID')
    ctx_parser.add_argument('--json', action='store_true', help='Output as JSON')
    ctx_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')

    # Scaling audit command
    sa_parser = subparsers.add_parser('scaling-audit', help='Audit recent orchestrator decisions for issues')
    sa_parser.add_argument('--hours', type=int, default=3, help='Time window (default: 3)')
    sa_parser.add_argument('--json', action='store_true', help='Output as JSON')
    sa_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')

    # Logs command
    logs_parser = subparsers.add_parser('logs', help='View system logs')
    logs_parser.add_argument('--source', help='Filter by source type (browser, worker, edge_function, orchestrator_gpu, orchestrator_api)')
    logs_parser.add_argument('--session', help='Legacy alias for source_id filter')
    logs_parser.add_argument('--source-id', help='Filter by system_logs.source_id (for example a browser session id)')
    logs_parser.add_argument('--metadata-session', help='Filter by metadata.session_id for a session UUID')
    logs_parser.add_argument('--latest', action='store_true', help='Show logs from most recent browser session')
    logs_parser.add_argument('--sessions', action='store_true', help='List recent browser sessions')
    logs_parser.add_argument('--tag', help='Filter by tag in message (e.g., TaskPoller, ShotNav, console)')
    logs_parser.add_argument('--level', help='Filter by log level (DEBUG, INFO, WARNING, ERROR)')
    logs_parser.add_argument('--hours', type=int, help='Filter by hours')
    logs_parser.add_argument('--limit', type=int, default=5000, help='Max logs to fetch (default: 5000, use 0 for unlimited)')
    logs_parser.add_argument('--json', action='store_true', help='Output as JSON')
    logs_parser.add_argument('--debug', action='store_true', help='Show debug info on errors')
    
    return parser


def main():
    """Main entry point."""
    parser = create_parser()
    args = parser.parse_args()
    
    # Convert args to options dict
    options = {
        'format': 'json' if hasattr(args, 'json') and args.json else 'text',
        'debug': args.debug if hasattr(args, 'debug') else False
    }

    # Create debug client (sql command doesn't need it)
    client = None
    if args.command != 'sql':
        try:
            client = DebugClient(verbose=options['debug'])
        except Exception as e:
            print(f"❌ Failed to initialize debug client: {e}")
            print("\n💡 Make sure your .env file is configured with:")
            print("   - SUPABASE_URL")
            print("   - SUPABASE_SERVICE_ROLE_KEY")
            sys.exit(1)
    
    # Add command-specific options
    if hasattr(args, 'hours') and args.hours:
        options['hours'] = args.hours
    if hasattr(args, 'limit'):
        options['limit'] = args.limit
    if hasattr(args, 'status') and args.status:
        options['status'] = args.status
    if hasattr(args, 'type') and args.type:
        options['type'] = args.type
    if hasattr(args, 'logs_only'):
        options['logs_only'] = args.logs_only
    if hasattr(args, 'all') and args.all:
        options['all'] = True

    # Add logs-specific options
    if hasattr(args, 'source') and args.source:
        options['source'] = args.source
    if hasattr(args, 'session') and args.session:
        options['session'] = args.session
    if hasattr(args, 'source_id') and args.source_id:
        options['source_id'] = args.source_id
    if hasattr(args, 'metadata_session') and args.metadata_session:
        options['metadata_session'] = args.metadata_session
    if hasattr(args, 'latest') and args.latest:
        options['latest'] = True
    if hasattr(args, 'sessions') and args.sessions:
        options['sessions'] = True
    if hasattr(args, 'tag') and args.tag:
        options['tag'] = args.tag
    if hasattr(args, 'level') and args.level:
        options['level'] = args.level
    
    # Route to appropriate command handler
    try:
        if args.command == 'sql':
            sql.run(args.query, options)
            return
        elif args.command in ('query', 'q'):
            options['select'] = args.select
            query.run(client, args.table, args.filters, options)
        elif args.command == 'task':
            task.run(client, args.task_id, options)
        elif args.command == 'tasks':
            tasks.run(client, options)
        elif args.command == 'pod':
            options['pod_id'] = args.pod_id
            pod.run(args.subcommand, options)
        elif args.command == 'pipeline':
            pipeline.run(client, args.task_id, options)
        elif args.command == 'workers':
            workers.run(client, options)
        elif args.command == 'queue':
            queue.run(client, options)
        elif args.command == 'logs':
            logs.run(client, options)
        elif args.command == 'worker-timeline':
            worker_timeline.run(client, args.worker_id, options)
        elif args.command == 'why-killed':
            why_killed.run(client, args.worker_id, options)
        elif args.command == 'task-journey':
            task_journey.run(client, args.task_id, options)
        elif args.command == 'context':
            context_cmd.run(client, args.entity_id, options)
        elif args.command == 'scaling-audit':
            scaling_audit.run(client, options)
        else:
            parser.print_help()
            sys.exit(1)
    except KeyboardInterrupt:
        print("\n\n👋 Interrupted by user")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Command failed: {e}")
        if options.get('debug'):
            import traceback
            traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
