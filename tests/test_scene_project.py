import importlib.util,sqlite3,tempfile,unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'fflow'))
from pc_scene_graphics_cli import resolve_project

class SceneProject(unittest.TestCase):
    def test_real_slug_not_job_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'real-project-123').mkdir();db=root/'test.db'
            with sqlite3.connect(db) as connection:
                connection.execute('CREATE TABLE pipeline_jobs(job_id TEXT, project_slug TEXT)')
                connection.execute('INSERT INTO pipeline_jobs VALUES (?,?)',('job-a','real-project-123'))
                connection.execute('INSERT INTO pipeline_jobs VALUES (?,?)',('bad','../outside'))
            connection.close()
            self.assertEqual(resolve_project('job-a',db,root),root/'real-project-123')
            self.assertIsNone(resolve_project('missing',db,root))
            self.assertIsNone(resolve_project('bad',db,root))

if __name__=='__main__':unittest.main()
