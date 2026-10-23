import json,tempfile,unittest
from pathlib import Path
from rag_json_array import iter_array

class Arrays(unittest.TestCase):
 def test_small_boundaries_unicode_nested_and_scalar_prefixes(self):
  cases=[[],[{'text':'नील ] , \\"'},{'nested':[1,2,{'a':True}]}],
   [{'long':'x'*5000}],[12,12345,-52.2,1e15,True,'abc',None,{}]]
  with tempfile.TemporaryDirectory() as d:
   path=Path(d)/'data.json'
   for value in cases:
    path.write_text(json.dumps(value,ensure_ascii=False))
    for size in [1,7,31,1024]:
     with self.subTest(valueType=str(type(value)),size=size):self.assertEqual(list(iter_array(path,size)),value)
 def test_incomplete_or_ambiguous_input_refuses(self):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d)/'data.json'
   for value in ['[1,]','[1 2]','[1','{}','[]false','[1e]']:
    path.write_text(value)
    with self.subTest(value=value),self.assertRaises(ValueError):list(iter_array(path,7))
if __name__=='__main__':unittest.main()
