from pathlib import Path
import subprocess,json
checks={}
commands={
 'build':['npm','run','build'],
 'web':['npm','test'],
 'python':['bash','-c','source /opt/ros/humble/setup.bash && source /home/orangepi/ugv/install/setup.bash && source install/setup.bash && /usr/bin/python3 -m unittest discover -s tests -p "test_node*.py"'],
 'compile':['python3','-m','compileall','-q','src/greenhouse_navigation/greenhouse_navigation'],
}
for name,cmd in commands.items():
 with open('logs/motion-recording-'+name+'.log','w') as log:
  result=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
 checks[name]=result.returncode
 Path('logs/motion-recording-checks.json').write_text(json.dumps(checks))
