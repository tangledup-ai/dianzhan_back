-- v3：Rent 页展开详情需要「进项成本」（品牌方合同开票/进项金额），contracts 加列
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS input_cost NUMERIC(12,2);
