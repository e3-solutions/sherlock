"""Capture an immutable CI run's actual conclusion, including required steps."""
import argparse
import json
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('run_id')
parser.add_argument('head_sha')
parser.add_argument('--full', action='store_true')
args = parser.parse_args()
result = subprocess.run(
    ['gh', 'run', 'view', args.run_id, '--repo', 'e3-solutions/sherlock',
     '--json', 'headSha,status,conclusion,jobs'],
    capture_output=True, text=True, check=True,
)
run = json.loads(result.stdout)
summary = {
    'url': f'https://github.com/e3-solutions/sherlock/actions/runs/{args.run_id}',
    'head': run['headSha'], 'status': run['status'], 'conclusion': run['conclusion'],
    'jobs': [{'name': job['name'], 'conclusion': job['conclusion'],
              'steps': [{'name': step['name'], 'conclusion': step['conclusion']}
                        for step in job['steps']]} for job in run['jobs']],
}
print(json.dumps(summary, indent=2), flush=True)
assert run['headSha'] == args.head_sha, 'CI did not test the expected commit'
assert run['status'] == 'completed' and run['conclusion'] == 'success', 'CI did not pass'
for platform in ('ubuntu-latest', 'macos-latest', 'windows-latest'):
    jobs = [job for job in run['jobs'] if f'collector ({platform})' in job['name']]
    assert len(jobs) == 1 and jobs[0]['conclusion'] == 'success', f'{platform} did not pass'
windows = next(job for job in run['jobs'] if 'collector (windows-latest)' in job['name'])
for name in ('Portable process and durability tests', 'Native trust pipe transport',
             'Windows PowerShell 5.1 installation and hooks',
             'Real Windows provider registration and reinstall'):
    assert any(step['name'] == name and step['conclusion'] == 'success'
               for step in windows['steps']), f'{name} did not pass'
if args.full:
    assert any(job['name'] == 'Test' and job['conclusion'] == 'success'
               for job in run['jobs']), 'Full repository CI did not pass'
